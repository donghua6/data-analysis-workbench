import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
import pyarrow as pa
import pyarrow.parquet as pq
from server import parse_lerobot
from lerobot_local import discover, load, inside, video_files

class LocalLeRobotTests(unittest.TestCase):
    def test_position_command_mapping_excludes_velocity_and_filters_episode(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'shard.parquet'
            pq.write_table(pa.Table.from_pylist([
                {'timestamp':0.,'episode_index':0,'observation.state':[1.,99.,2.],'action':[2.1,1.1]},
                {'timestamp':0.,'episode_index':1,'observation.state':[3.,88.,4.],'action':[4.1,3.1]},
            ]),p)
            info={'features':{'observation.state':{'names':['left_joint_1.position','left_joint_1.velocity','right_joint_1.position']},'action':{'names':['right_joint_1.command','left_joint_1.command']}}}
            result=parse_lerobot([p],info,episode_index=1)
            self.assertEqual(len(result),1)
            joints={j['name']:j for j in result[0]['joints']}
            self.assertEqual(joints['left_joint_1']['state'],[[0.,3.]])
            self.assertEqual(joints['left_joint_1']['action'],[[0.,3.1]])
            self.assertEqual(joints['left_joint_1']['group'],'left_arm')
            info['features']['action']['names']=['unknown.command','left_joint_1.command']
            with self.assertRaisesRegex(ValueError,'名称'):
                parse_lerobot([p],info)

    def test_discovery_skips_ingest_and_video_access_is_registered(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'A/dataset';(root/'meta').mkdir(parents=True)
            info={'data_path':'data/episode_{episode_index:06d}.parquet','video_path':'videos/{video_key}/episode_{episode_index:06d}.mp4','features':{'observation.images.cam0':{'dtype':'video'}}}
            (root/'meta/info.json').write_text(json.dumps(info))
            (root/'meta/episodes.jsonl').write_text(json.dumps({'episode_index':0,'length':2}))
            copy=root/'ingest/sources/copy/meta';copy.mkdir(parents=True);(copy/'info.json').write_text('{}')
            video=root/'videos/observation.images.cam0/episode_000000.mp4';video.parent.mkdir(parents=True);video.write_bytes(b'video')
            found=discover(Path(d));self.assertEqual(len(found),1)
            options=SimpleNamespace(state_column='observation.state',action_column='action',positional=False,unit='rad')
            data=root/'data/episode_000000.parquet';data.parent.mkdir();pq.write_table(pa.Table.from_pylist([{'timestamp':0.,'episode_index':0,'source_timestamp_ns':1793343606921142182}]),data)
            result=load(found[0],lambda *a,**k:[{'joints':[]}],options)
            self.assertEqual(result[0]['timeline']['times'],[0.])
            self.assertEqual(result[0]['timeline']['source_timestamps_ns'],['1793343606921142182'])
            camera=result[0]['cameras'][0]
            self.assertTrue(camera['available']);self.assertEqual(video_files[camera['url'].split('/')[-1]],video.resolve())
            with self.assertRaisesRegex(ValueError,'越出'):
                inside(root,'../secret.mp4')

    def test_mixed_fr3_position_hand_command_and_multi_episode_root(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'dataset';(root/'meta').mkdir(parents=True);(root/'data').mkdir()
            info={'data_path':'data/episode_{episode_index:06d}.parquet','video_path':'videos/{video_key}/{episode_index}.mp4','fps':30,'features':{
                'observation.state':{'names':['left_fr3_joint1.position','left_fr3_joint1.velocity','left_thumb_IP.position']},
                'action':{'names':['left_thumb_IP.command','left_fr3_joint1.position']}}}
            (root/'meta/info.json').write_text(json.dumps(info))
            (root/'meta/episodes.jsonl').write_text('\n'.join(json.dumps({'episode_index':i,'length':1}) for i in [1,0]))
            for i in [0,1]:
                pq.write_table(pa.Table.from_pylist([{'timestamp':0.,'episode_index':i,'observation.state':[1.+i,99.,2.+i],'action':[2.1+i,1.1+i]}]),root/f'data/episode_{i:06d}.parquet')
            found=discover(root);self.assertEqual([r['episode'] for r in found],[0,1]);self.assertEqual(found[0]['episode_count'],2)
            opts=SimpleNamespace(state_column='observation.state',action_column='action',positional=False,unit='rad')
            first,second=[load(r,parse_lerobot,opts)[0] for r in found]
            joints={j['name']:j for j in second['joints']}
            self.assertEqual(joints['left_fr3_joint1']['group'],'left_arm')
            self.assertEqual(joints['left_thumb_IP']['group'],'left_hand')
            self.assertEqual(joints['left_fr3_joint1']['state'],[[0.,2.]])
            self.assertEqual(joints['left_fr3_joint1']['action'],[[0.,2.1]])
            self.assertNotEqual(first['joints'][0]['state'],second['joints'][0]['state'])

    def test_ur_named_action_subset_preserves_state_only_hands(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'data/lerobot/current/lemon';(root/'meta').mkdir(parents=True);(root/'data').mkdir()
            info={'data_path':'data/episode_{episode_index:06d}.parquet','video_path':'unused','fps':10,'features':{
                'observation.state':{'names':['left_shoulder_pan_joint.position','left_thumb_tip.position','right_wrist_3_joint.position']},
                'action':{'names':['right_wrist_3_joint.position','left_shoulder_pan_joint.position']}}}
            (root/'meta/info.json').write_text(json.dumps(info));(root/'meta/episodes.jsonl').write_text(json.dumps({'episode_index':0,'length':1}))
            pq.write_table(pa.Table.from_pylist([{'timestamp':0.,'episode_index':0,'observation.state':[1.,2.,3.],'action':[3.1,1.1]}]),root/'data/episode_000000.parquet')
            found=discover(Path(d));self.assertEqual(len(found),1)
            opts=SimpleNamespace(state_column='observation.state',action_column='action',positional=False,unit='rad')
            result=load(found[0],parse_lerobot,opts)[0];js={j['name']:j for j in result['joints']}
            self.assertEqual(result['channel_summary'],dict(paired=2,state_only=1))
            self.assertEqual(js['left_thumb_tip']['action'],[])
            self.assertEqual(js['left_thumb_tip']['state'],[[0.,2.]])
            self.assertEqual(js['left_thumb_tip']['group'],'left_hand')
            self.assertEqual(js['right_wrist_3_joint']['group'],'right_arm')
            self.assertEqual(js['left_shoulder_pan_joint']['action'],[[0.,1.1]])

    def test_wuji_short_hand_prefixes_and_legacy_arm_groups(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'ep.parquet';names=['left_arm_joint1','right_fr3_joint1','l_thumb_cmc_flex','r_index_finger_pip']
            pq.write_table(pa.Table.from_pylist([{'timestamp':0.,'observation.state':[1.,2.,3.,4.],'action':[1.1,2.1,3.1,4.1]}]),p)
            info={'features':{'observation.state':{'names':names},'action':{'names':names}}}
            result=parse_lerobot([p],info)[0]
            self.assertEqual([j['group'] for j in result['joints']],['left_arm','right_arm','left_hand','right_hand'])
            self.assertEqual(result['channel_summary']['paired'],4)
