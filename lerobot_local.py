"""Discover local LeRobot episodes and issue opaque, session-only video URLs."""
import json
import os
import secrets
from pathlib import Path

video_files = {}


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('数据集文件路径越出根目录')
    return path


def discover(path):
    path = Path(path)
    # Archive roots may contain raw bags/checkpoints beside the LeRobot tree.
    if (path / 'data/lerobot').is_dir():
        path = path / 'data/lerobot'
    roots = []
    # Stop at a dataset root: do not scan ingest/sources copies inside it.
    for directory, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('ingest', 'conversion', 'videos'))
        root = Path(directory)
        if (root / 'meta/info.json').is_file():
            roots.append(root)
            dirs[:] = []
        if len(roots) > 100:
            raise ValueError('数据集过多，请选择更具体的目录')
    result = []
    for root in roots:
        info = json.loads((root / 'meta/info.json').read_text())
        # v2 episode metadata avoids reading large multimodal Parquet just to list recordings.
        manifest = root / 'meta/episodes.jsonl'
        if manifest.exists():
            episodes = [json.loads(line) for line in manifest.read_text().splitlines() if line.strip()]
        else:
            # v3 metadata contains data/video shard locations and episode time offsets.
            import pyarrow.parquet as pq
            episodes = [row for p in sorted((root / 'meta/episodes').rglob('*.parquet')) for row in pq.read_table(p).to_pylist()]
        episodes.sort(key=lambda ep: int(ep['episode_index']))
        label = str(root.relative_to(path)) if len(roots)>1 else root.name
        for ep in episodes:
            i = int(ep['episode_index'])
            result.append(dict(index=len(result), kind='lerobot', root=str(root), episode=i,
                               name=f'{label} · episode {i:06d}',
                               frames=ep.get('length'), fps=info.get('fps'), metadata=ep,
                               dataset_name=root.name, episode_count=len(episodes), robot_type=info.get('robot_type',''),
                               cameras=[k for k,v in info.get('features',{}).items() if v.get('dtype')=='video']))
    return result


def load(record, parser, options):
    root = Path(record['root']); ep = record['episode']; meta = record['metadata']
    info = json.loads((root / 'meta/info.json').read_text())
    args = dict(episode_index=ep, episode_chunk=ep // info.get('chunks_size',1000),
                chunk_index=meta.get('data/chunk_index',0), file_index=meta.get('data/file_index',0))
    data = inside(root, info['data_path'].format(**args))
    datasets = parser([data], info, episode_index=ep, state_column=options.state_column,
                      action_column=options.action_column, positional=options.positional, unit=options.unit)
    import pyarrow.parquet as pq
    # Only read timing columns; retain nanoseconds as strings for JS precision.
    pf = pq.ParquetFile(data)
    columns = [c for c in ('timestamp','episode_index','source_timestamp_ns') if c in pf.schema_arrow.names]
    rows = [row for batch in pf.iter_batches(columns=columns) for row in batch.to_pylist()
            if row.get('episode_index',ep) == ep]
    rows.sort(key=lambda row: row['timestamp'])
    times = [float(row['timestamp']) for row in rows]
    for dataset in datasets:
        dataset['timeline'] = dict(times=times, fps=info.get('fps'),
                                   source_timestamps_ns=[str(row['source_timestamp_ns']) for row in rows] if rows and 'source_timestamp_ns' in rows[0] else [],
                                   basis='LeRobot episode timestamp')
        dataset['name'] = record['name']
        dataset['cameras'] = []
        dataset['source_path'] = str(root)
        dataset['dataset_name'] = root.name
        dataset['episode_count'] = record.get('episode_count',info.get('total_episodes',1))
        dataset['robot_type'] = info.get('robot_type','')
        for key in record['cameras']:
            video_args = dict(args, video_key=key,
                              chunk_index=meta.get(f'videos/{key}/chunk_index',args['chunk_index']),
                              file_index=meta.get(f'videos/{key}/file_index',args['file_index']))
            path = inside(root, info['video_path'].format(**video_args))
            camera = dict(name=key.rsplit('.',1)[-1], key=key, available=path.is_file(),
                          offset=float(meta.get(f'videos/{key}/from_timestamp',0)))
            if camera['available']:
                # Reuse tokens on reimport; registry never exposes arbitrary local files.
                token = next((t for t,p in video_files.items() if p==path), None) or secrets.token_urlsafe(24)
                video_files[token] = path
                camera['url'] = '/api/video/' + token
            dataset['cameras'].append(camera)
    return datasets
