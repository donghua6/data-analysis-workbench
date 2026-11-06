"""Local-only parsing service. Never execute uploaded code; never extract archives."""
from __future__ import annotations
import json
import math
import tempfile
from pathlib import Path, PurePosixPath
from typing import Annotated
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from capture_import import recordings, info as capture_info, parse_capture

ROOT = Path(__file__).parent
app = FastAPI(title="JointScope local parser")
MAX_UPLOAD = 512 * 1024 * 1024
MAX_POINTS = 2_000_000


def finite(value):
    n = float(value)
    if not math.isfinite(n):
        raise ValueError("数据包含 NaN / Infinity")
    return n


def series(joints, name, unit):
    if name not in joints:
        joints[name] = dict(name=name, unit=unit, state=[], action=[])
    return joints[name]


def field(msg, path):
    for part in path.split('.'):
        msg = getattr(msg, part)
    return msg


def parse_ros(path, *, state_topic, action_topic, state_field='position', action_field='position', positional=False, unit='rad'):
    from rosbags.highlevel import AnyReader
    from rosbags.typesys import Stores, get_typestore
    if not state_topic or not action_topic or state_topic == action_topic:
        raise ValueError("请配置不同的 State / Action Topic。标准 JointState 使用 position 字段。")
    joints = {}
    with AnyReader([Path(path)], default_typestore=get_typestore(Stores.ROS2_HUMBLE)) as reader:
        topics = sorted({c.topic for c in reader.connections})
        if not {state_topic, action_topic}.issubset(topics):
            raise ValueError("Topic 不存在。可用 Topic：" + ', '.join(topics))
        conns = [c for c in reader.connections if c.topic in (state_topic, action_topic)]
        # Read both named and unnamed vectors, then resolve unnamed by the explicit index opt-in.
        vectors = []
        state_names = None
        t0 = None
        count = 0
        for connection, timestamp, raw in reader.messages(connections=conns):
            key = 'state' if connection.topic == state_topic else 'action'
            msg = reader.deserialize(raw, connection.msgtype)
            values = field(msg, state_field if key == 'state' else action_field)
            values = [finite(v) for v in values]
            names = list(getattr(msg, 'name', []))
            if names and len(names) != len(values):
                raise ValueError(f"{connection.topic}: name 与数值维度不一致")
            if names and (len(set(names)) != len(names) or any(not n for n in names)):
                raise ValueError("ROS 关节名缺失或重复")
            if key == 'state' and names:
                if state_names is not None and state_names != names and positional:
                    raise ValueError("State 关节顺序在录制中变化，不能安全按索引映射")
                state_names = names
            t0 = timestamp if t0 is None else t0
            vectors.append((key, (timestamp - t0) / 1e9, names, values))
            count += len(values)
            if count > MAX_POINTS:
                raise ValueError("数据超过 200 万点，请先按时间裁剪 bag")
        if t0 is None:
            raise ValueError("所选 Topic 没有消息")
        for key, t, names, values in vectors:
            if not names:
                if not positional:
                    raise ValueError("消息没有 name 数组；请显式允许按索引匹配，并核实关节顺序")
                names = state_names or [f'joint_{i}' for i in range(len(values))]
                if len(names) != len(values):
                    raise ValueError("无名称消息与 State 关节维度不一致，需自定义映射")
            for n, v in zip(names, values):
                series(joints, n, unit)[key].append([t, v])
    if not any(j['state'] for j in joints.values()) or not any(j['action'] for j in joints.values()):
        raise ValueError("State 或 Action Topic 无可用数值")
    return [dict(name=Path(path).name, joints=list(joints.values()), time_basis='bag recording timestamp; seconds from first selected message')]


def feature_names(info, column, size):
    names = info.get('features', {}).get(column, {}).get('names')
    if isinstance(names, dict):
        names = names.get('motors') or names.get('joints')
    if isinstance(names, list) and len(names) == size and all(isinstance(n, str) for n in names):
        if len(set(names)) != size:
            raise ValueError(f'{column}: 关节名称重复')
        return names
    return None


def parse_lerobot(files, info=None, *, state_column='observation.state', action_column='action', positional=False, unit='rad', episode_index=None):
    import pyarrow.parquet as pq
    info = info or {}
    episodes = {}
    signature = None
    point_count = 0
    position_mapping = False
    for path in sorted(files):
        pf = pq.ParquetFile(path)
        required = ['timestamp', state_column, action_column]
        available = pf.schema_arrow.names
        missing = [c for c in required if c not in available]
        if missing:
            raise ValueError('Parquet 缺少字段：' + ', '.join(missing))
        cols = required + (['episode_index'] if 'episode_index' in available else [])
        for batch in pf.iter_batches(batch_size=4096, columns=cols):
            for row in batch.to_pylist():
                if episode_index is not None and row.get('episode_index') != episode_index:
                    continue
                sv, av = row[state_column], row[action_column]
                if sv is None or av is None:
                    raise ValueError('State / Action 存在空数组')
                sig = (len(sv), len(av))
                if signature is not None and signature != sig:
                    raise ValueError('不同帧的向量维度不一致')
                signature = sig
                sn, an = feature_names(info, state_column, len(sv)), feature_names(info, action_column, len(av))
                # Explicit position/command names allow mixed position+velocity State vectors.
                if sn and an and all(n.endswith(('.command', '.position')) for n in an):
                    positions = {n.removesuffix('.position'): i for i, n in enumerate(sn) if n.endswith('.position')}
                    targets = [n.rsplit('.', 1)[0] for n in an]
                    if len(targets) == len(set(targets)) and set(targets).issubset(positions):
                        state_names = list(positions)
                        sv = [sv[positions[n]] for n in state_names]
                        sn, an = state_names, targets
                        position_mapping = True
                if sn is None or an is None or not set(an).issubset(sn):
                    if not positional:
                        raise ValueError('State / Action 名称无法一一对应。请选择包含 meta/info.json 的数据集目录，或在核实顺序后允许索引匹配。')
                    if len(sv) != len(av):
                        raise ValueError('State / Action 维度不同，不能按索引比较。请先将动作转换到相同关节空间。')
                    sn = sn or [f'joint_{i}' for i in range(len(sv))]
                    an = sn
                # Keep episodes independent, especially v3 shards with timestamp resetting per episode.
                ep = row.get('episode_index', Path(path).stem)
                joints = episodes.setdefault(str(ep), {})
                t = finite(row['timestamp'])
                for key, names, values in [('state', sn, sv), ('action', an, av)]:
                    for n, v in zip(names, values):
                        series(joints, n, unit)[key].append([t, finite(v)])
                        point_count += 1
                        if point_count > MAX_POINTS:
                            raise ValueError('数据超过 200 万点，请缩小数据集范围')
    results = []
    for ep, joints in episodes.items():
        for j in joints.values():
            for key in ('state', 'action'):
                j[key].sort(key=lambda p: p[0])
                if any(a[0] == b[0] for a, b in zip(j[key], j[key][1:])):
                    raise ValueError(f'episode {ep} 存在重复时间戳，请检查是否重复选择数据文件')
        for j in joints.values():
            for side in ('left', 'right'):
                if j['name'].startswith((side + '_joint_', side + '_arm_joint', side + '_fr3_joint', side + '_shoulder_', side + '_elbow_joint', side + '_wrist_')):
                    j['group'] = side + '_arm'
                elif any(j['name'].startswith(prefix + '_' + finger + '_') for prefix in (side, 'l' if side=='left' else 'r') for finger in ('thumb','index','middle','ring','pinky','little')):
                    j['group'] = side + '_hand'
        paired = sum(bool(j['state'] and j['action']) for j in joints.values())
        state_only = sum(bool(j['state'] and not j['action']) for j in joints.values())
        results.append(dict(channel_summary=dict(paired=paired,state_only=state_only), warnings=[f'{state_only} 个关节仅有 State，未计算误差'] if state_only else [], name=f'LeRobot · episode {ep}', episode_index=ep, joints=list(joints.values()), mapping_note='仅对比关节位置与目标，速度维度未载入' if position_mapping else ''))
    if not results:
        raise ValueError('Parquet 无数据')
    return results


def parse_upload(root, **options):
    files = [p for p in root.rglob('*') if p.is_file()]
    parquet = [p for p in files if p.suffix == '.parquet' and 'meta' not in p.relative_to(root).parts]
    if parquet:
        info_paths = [p for p in files if p.name == 'info.json' and p.parent.name == 'meta']
        info = json.loads(info_paths[0].read_text()) if info_paths else {}
        return parse_lerobot(parquet, info, **{k: options[k] for k in ('state_column', 'action_column', 'positional', 'unit')})
    if not options.get('state_topic') and not options.get('action_topic'):
        paths = recordings(root)
        return [d for path in paths for d in parse_capture(path, unit=options.get('unit','rad'))]
    bags = [p for p in files if p.suffix == '.bag']
    metadata = [p for p in files if p.name == 'metadata.yaml']
    if len(bags) + len(metadata) != 1:
        raise ValueError('请选择一个 ROS1 .bag 文件，或包含 metadata.yaml 的完整 ROS2 bag 目录（支持 db3 / mcap 存储）。')
    path = bags[0] if bags else metadata[0].parent
    return parse_ros(path, **{k: options[k] for k in ('state_topic', 'action_topic', 'state_field', 'action_field', 'positional', 'unit')})


@app.get('/api/health')
def health():
    return {'service': 'jointscope', 'capabilities':['capture_directory','lerobot_local','camera_video'], 'version':3}


@app.post('/api/import')
async def import_data(
    files: Annotated[list[UploadFile], File()],
    state_topic: Annotated[str, Form()] = '', action_topic: Annotated[str, Form()] = '',
    state_field: Annotated[str, Form()] = 'position', action_field: Annotated[str, Form()] = 'position',
    state_column: Annotated[str, Form()] = 'observation.state', action_column: Annotated[str, Form()] = 'action',
    positional: Annotated[bool, Form()] = False, unit: Annotated[str, Form()] = 'rad',
):
    import asyncio
    options = dict(state_topic=state_topic, action_topic=action_topic, state_field=state_field, action_field=action_field,
                   state_column=state_column, action_column=action_column, positional=positional, unit=unit)
    try:
        with tempfile.TemporaryDirectory(prefix='jointscope-') as directory:
            root = Path(directory)
            total = 0
            for upload in files:
                relative = PurePosixPath((upload.filename or '').replace('\\', '/'))
                if relative.is_absolute() or '..' in relative.parts or not relative.name:
                    raise ValueError('文件路径无效')
                target = root.joinpath(*relative.parts)
                if target.exists():
                    raise ValueError('存在同名或重复文件')
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('wb') as out:
                    while chunk := await upload.read(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_UPLOAD:
                            raise ValueError('上传超过 512 MB，请裁剪或仅选择需要的 Parquet 数据分片和 meta/info.json')
                        out.write(chunk)
            datasets = await asyncio.to_thread(parse_upload, root, **options)
            return {'datasets': datasets}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

class LocalRequest(BaseModel):
    path: str
    recording: int = 0
    auto: bool = True
    aligned: bool = False
    state_topic: str = ''
    action_topic: str = ''
    state_field: str = 'position'
    action_field: str = 'position'
    positional: bool = False
    unit: str = 'rad'
    state_column: str = 'observation.state'
    action_column: str = 'action'


def local_path(value):
    from urllib.parse import urlsplit, unquote
    import os
    value=value.strip()
    if value.startswith('sftp://'):
        url=urlsplit(value)
        mounts=Path(f'/run/user/{os.getuid()}/gvfs')
        matches=[]
        for mount in mounts.glob('sftp:*'):
            props=dict(part.split('=',1) for part in mount.name.removeprefix('sftp:').split(',') if '=' in part)
            if props.get('host')==url.hostname and (not url.username or props.get('user')==unquote(url.username)) and (not url.port or props.get('port','22')==str(url.port)):
                matches.append(mount)
        if len(matches)!=1:
            raise ValueError('未找到对应的已挂载 SFTP 共享，请先在文件管理器连接，再复制完整目录地址。')
        return matches[0]/unquote(url.path).lstrip('/')
    path=Path(value).expanduser()
    if not value or not path.is_absolute():
        raise ValueError('请输入绝对目录路径，或已挂载的 sftp:// 地址。')
    return path


@app.post('/api/local-inspect')
async def inspect_local(request: LocalRequest):
    import asyncio
    try:
        def inspect():
            path = local_path(request.path)
            from lerobot_local import discover
            found = discover(path)
            if found:
                return {'recordings': found}
            return {'recordings':[dict(index=i, **capture_info(p)) for i,p in enumerate(recordings(path))]}
        return await asyncio.to_thread(inspect)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post('/api/local-import')
async def import_local(request: LocalRequest):
    import asyncio
    try:
        def parse():
            from lerobot_local import discover, load
            found = discover(local_path(request.path))
            if found:
                if not 0 <= request.recording < len(found):
                    raise ValueError('录制选择已失效，请重新扫描目录')
                return load(found[request.recording], parse_lerobot, request)
            paths=recordings(local_path(request.path))
            if not 0<=request.recording<len(paths):
                raise ValueError('录制选择已失效，请重新扫描目录')
            path=paths[request.recording]
            if request.auto:
                return parse_capture(path, unit=request.unit, aligned=request.aligned)
            return parse_ros(path, **request.model_dump(include={'state_topic','action_topic','state_field','action_field','positional','unit'}))
        return {'datasets':await asyncio.to_thread(parse)}
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get('/api/video/{token}')
async def video(token: str):
    from fastapi.responses import FileResponse
    from lerobot_local import video_files
    path = video_files.get(token)
    if path is None or not path.is_file():
        raise HTTPException(404, '视频不存在或服务已重启，请重新导入')
    return FileResponse(path, media_type='video/mp4')


app.mount('/', StaticFiles(directory=ROOT / 'dist', html=True), name='ui')
if __name__ == '__main__':
    import uvicorn
    import argparse
    parser = argparse.ArgumentParser(description='JointScope 独立关节分析界面（原数据工作流保留 8765）')
    parser.add_argument('--port', type=int, default=8877)
    args = parser.parse_args()
    if args.port == 8765:
        parser.error('8765 保留给原数据工作流，请使用默认 8877 或其他端口')
    uvicorn.run(app, host='127.0.0.1', port=args.port)
