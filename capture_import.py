"""Read capture folders locally; metadata files are data, never executable configuration."""
import json
from pathlib import Path
from rosbags.highlevel import AnyReader
from rosbags.typesys import Stores, get_typestore


def recordings(root):
    root = Path(root)
    if root.is_file():
        return [root] if root.suffix == '.bag' else []
    if not root.is_dir():
        raise ValueError('目录不存在或不可读取。共享目录请使用已挂载的本机路径。')
    # A selected episode takes precedence over traversing a larger collection.
    if (root / 'metadata.yaml').is_file():
        return [root]
    if (root / 'bag' / 'metadata.yaml').is_file():
        return [root / 'bag']
    found = sorted({p.parent for p in root.rglob('metadata.yaml')} | set(root.rglob('*.bag')))
    if not found:
        raise ValueError('未找到 ROS bag。请选择含 bag/metadata.yaml 的采集目录、bag 目录，或 ROS1 .bag。alignment.json、capture_config.json 和校验日志不是关节数据。')
    if len(found) > 100:
        raise ValueError('目录包含超过 100 个录制，请选择更具体的 episode 目录。')
    return found


def info(path):
    path = Path(path)
    if path.is_dir():
        from ruamel.yaml import YAML
        meta = YAML(typ='safe').load((path/'metadata.yaml').read_text())['rosbag2_bagfile_information']
        topics = [{'name':t['topic_metadata']['name'], 'type':t['topic_metadata']['type'], 'count':t['message_count']} for t in meta['topics_with_message_count']]
    else:
        with AnyReader([path], default_typestore=get_typestore(Stores.ROS1_NOETIC)) as reader:
            topics = [{'name':c.topic, 'type':c.msgtype, 'count':c.msgcount} for c in reader.connections]
    by_name = {t['name']:t for t in topics}
    pairs = []
    for topic in topics:
        name = topic['name']
        if not name.endswith('/joint_states') or topic['type'] != 'sensor_msgs/msg/JointState':
            continue
        base = name.removesuffix('/joint_states')
        action = next((base+s for s in ['/command','/joint_commands','/action','/commands'] if base+s in by_name and by_name[base+s]['type']=='sensor_msgs/msg/JointState'), None)
        if action:
            side = 'left' if '/left' in base else 'right' if '/right' in base else None
            part = 'hand' if any(k in base.lower() for k in ['sharpa','shaper','hand']) else 'arm'
            pairs.append({'state':name, 'action':action, 'prefix':base.strip('/').replace('/','_'), 'group':f'{side}_{part}' if side else 'other'})
    return {'name':path.parent.name if path.name=='bag' else path.name, 'topics':topics, 'pairs':pairs}


def joint_messages(path, topics):
    """Avoid reader startup COUNT scans of multi-GB camera bags on mounted shares."""
    from contextlib import ExitStack
    import sqlite3
    import heapq
    path=Path(path)
    store=get_typestore(Stores.ROS2_HUMBLE)
    if path.is_dir():
        from ruamel.yaml import YAML
        metadata=YAML(typ='safe').load((path/'metadata.yaml').read_text())['rosbag2_bagfile_information']
        paths=[(path/p).resolve() for p in metadata.get('relative_file_paths',[])]
        if paths and all(p.suffix=='.db3' for p in paths):
            with ExitStack() as stack:
                streams=[]
                for db in paths:
                    if not db.is_relative_to(path.resolve()):
                        raise ValueError('metadata.yaml 中的数据路径超出 bag 目录')
                    conn=sqlite3.connect(db.as_uri()+'?immutable=1',uri=True)
                    stack.callback(conn.close)
                    names={row[0]:(row[1],row[2]) for row in conn.execute('SELECT id,name,type FROM topics') if row[1] in topics}
                    ids=list(names)
                    if not ids:
                        continue
                    query='SELECT timestamp,topic_id,data FROM messages WHERE topic_id IN ('+','.join('?' for _ in ids)+') ORDER BY timestamp'
                    def stream(connection,names,query,ids):
                        for timestamp,topic_id,raw in connection.execute(query,ids):
                            topic,msgtype=names[topic_id]
                            yield timestamp,topic,raw,msgtype
                    streams.append(stream(conn,names,query,ids))
                for timestamp,topic,raw,msgtype in heapq.merge(*streams,key=lambda x:x[0]):
                    yield topic,timestamp,store.deserialize_cdr(raw,msgtype)
            return
    with AnyReader([path],default_typestore=store) as reader:
        conns=[c for c in reader.connections if c.topic in topics]
        for c,t,raw in reader.messages(connections=conns):
            yield c.topic,t,reader.deserialize(raw,c.msgtype)


def parse_capture(path, *, unit='rad', aligned=False, max_points=2_000_000):
    from server import finite
    path = Path(path)
    description = info(path)
    pairs = description['pairs']
    if not pairs:
        raise ValueError('未找到可自动配对的 JointState state/command Topic，请使用手动 Topic 模式。')
    # All limbs share one timestamp origin; do not concatenate independently zeroed datasets.
    mapping = {}
    for pair in pairs:
        mapping[pair['state']] = (pair, 'state')
        mapping[pair['action']] = (pair, 'action')
    alignment = None
    if aligned:
        ap = path.parent/'alignment.json'
        if not ap.is_file():
            raise ValueError('未找到 alignment.json，请取消对齐裁剪')
        alignment = json.loads(ap.read_text())
        if alignment.get('clock') != 'source_host_time_ns':
            raise ValueError('不支持该 alignment 时钟，请取消对齐裁剪')
        for k in ['start_time_ns','end_time_ns','relative_time_origin_ns']:
            if not isinstance(alignment.get(k), int):
                raise ValueError('alignment.json 缺少有效纳秒时间字段')
        if alignment['end_time_ns'] < alignment['start_time_ns']:
            raise ValueError('alignment.json 时间区间无效')
    joints = {}
    counts = {key:0 for key in mapping}
    t0 = alignment['relative_time_origin_ns'] if alignment else None
    count = 0
    for topic, timestamp, msg in joint_messages(path, mapping):
        pair, key = mapping[topic]
        # Alignment's source clock is explicitly header.stamp in this capture format.
        if alignment:
            stamp = msg.header.stamp
            timestamp = int(stamp.sec)*1_000_000_000+int(stamp.nanosec)
            if not alignment['start_time_ns'] <= timestamp <= alignment['end_time_ns']:
                continue
        if t0 is None:
            t0 = timestamp
        names, values = list(msg.name), list(msg.position)
        if not names or len(names)!=len(values) or len(set(names))!=len(names):
            raise ValueError(f'{topic}: 关节名称缺失、重复或与 position 维度不符，请使用手动模式')
        counts[topic] += 1
        for name, value in zip(names, values):
            identifier = pair['prefix']+'/'+name
            j = joints.setdefault(identifier, dict(name=identifier, group=pair['group'], unit=unit, state=[], action=[]))
            j[key].append([(timestamp-t0)/1e9,finite(value)])
            count += 1
            if count > max_points:
                raise ValueError('关节数据超过 200 万点，请选择较短的 episode')
    missing = [topic for topic,n in counts.items() if not n]
    if missing:
        raise ValueError('所选窗口无数据：'+', '.join(missing))
    for j in joints.values():
        for key in ['state','action']:
            j[key].sort(key=lambda p:p[0])
    warnings = [j['name'] for j in joints.values() if not j['state'] or not j['action']]
    return [dict(name=description['name'],joints=list(joints.values()),warnings=warnings,
                 time_basis='header.stamp + alignment.json' if alignment else 'bag recording timestamp; common origin for all limbs')]
