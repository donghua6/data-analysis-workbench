import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from rosbags.rosbag2 import Writer
from rosbags.typesys import Stores, get_typestore
from capture_import import recordings, info, parse_capture
from server import local_path

class CaptureTests(unittest.TestCase):
    def make_episode(self, root):
        episode=Path(root)/'episode_demo';episode.mkdir()
        for name in ['capture_config.json','alignment.json','rating.json','validation_report.json']:
            (episode/name).write_text('{}')
        (episode/'rosbag.log').write_text('log only')
        store=get_typestore(Stores.ROS2_HUMBLE);T=store.types
        with Writer(episode/'bag',version=9) as w:
            for limb,offset in [('marvin/left',0),('marvin/right',10),('sharpa/left',20),('sharpa/right',30)]:
                for i,suffix in enumerate(['joint_states','command']):
                    c=w.add_connection('/'+limb+'/'+suffix,'sensor_msgs/msg/JointState',typestore=store)
                    # Deliberately reuse joint names between every limb.
                    for frame in range(2):
                        ns=1_000_000_000+offset*1_000_000+i*5_000_000+frame*100_000_000
                        msg=T['sensor_msgs/msg/JointState'](T['std_msgs/msg/Header'](T['builtin_interfaces/msg/Time'](ns//10**9,ns%10**9),''),['joint_1'],np.array([offset+frame+i*.1]),np.array([],dtype=np.float64),np.array([],dtype=np.float64))
                        w.write(c,ns,store.serialize_cdr(msg,c.msgtype))
        return episode

    def test_capture_parent_and_bag_both_discover_all_limbs(self):
        with tempfile.TemporaryDirectory() as d:
            ep=self.make_episode(d)
            self.assertEqual(recordings(ep),[ep/'bag'])
            self.assertEqual(recordings(ep/'bag'),[ep/'bag'])
            self.assertEqual(len(info(ep/'bag')['pairs']),4)
            dataset=parse_capture(ep/'bag')[0]
            self.assertEqual(len(dataset['joints']),4)
            self.assertEqual(len({j['name'] for j in dataset['joints']}),4)
            right=next(j for j in dataset['joints'] if j['group']=='right_arm')
            self.assertAlmostEqual(right['state'][0][0],.01)
            self.assertAlmostEqual(right['action'][0][0],.015)
            self.assertEqual(dataset['warnings'],[])

    def test_alignment_uses_header_source_clock_and_common_origin(self):
        with tempfile.TemporaryDirectory() as d:
            ep=self.make_episode(d)
            (ep/'alignment.json').write_text(json.dumps(dict(clock='source_host_time_ns',start_time_ns=1_090_000_000,end_time_ns=1_200_000_000,relative_time_origin_ns=1_090_000_000)))
            data=parse_capture(ep/'bag',aligned=True)[0]
            self.assertEqual(len(data['joints'][0]['state']),1)
            self.assertAlmostEqual(data['joints'][0]['state'][0][0],.01)

    def test_configs_without_bag_have_actionable_error(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'capture_config.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'不是关节数据'):
                recordings(d)

    def test_local_path_rejects_relative_path(self):
        with self.assertRaisesRegex(ValueError,'绝对'):
            local_path('episode_demo')
