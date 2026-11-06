import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import parse_lerobot, parse_ros, parse_upload

class ImportTests(unittest.TestCase):
    def test_lerobot_episode_separation_and_named_reorder(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'file-000.parquet'
            pq.write_table(pa.Table.from_pylist([
                {'timestamp':0.,'episode_index':0,'observation.state':[1.,2.],'action':[2.1,1.1]},
                {'timestamp':.1,'episode_index':0,'observation.state':[3.,4.],'action':[4.1,3.1]},
                {'timestamp':0.,'episode_index':1,'observation.state':[5.,6.],'action':[6.1,5.1]},
            ]), p)
            info={'features':{'observation.state':{'names':['a','b']},'action':{'names':['b','a']}}}
            data=parse_lerobot([p],info)
            self.assertEqual(len(data),2)
            self.assertEqual(data[0]['joints'][0]['action'],[[0.,1.1],[.1,3.1]])
            self.assertEqual(data[1]['joints'][0]['state'],[[0.,5.]])
            with self.assertRaisesRegex(ValueError,'名称'):
                parse_lerobot([p])
            self.assertEqual(len(parse_lerobot([p],positional=True)),2)
    def test_lerobot_dimension_mismatch_is_rejected(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'a.parquet'
            pq.write_table(pa.Table.from_pylist([{'timestamp':0.,'observation.state':[1.,2.],'action':[3.]}]),p)
            with self.assertRaisesRegex(ValueError,'维度不同'):
                parse_lerobot([p],positional=True)
    def test_ros1_actual_bag_named_jointstate(self):
        import numpy as np
        from rosbags.rosbag1 import Writer
        from rosbags.typesys import Stores,get_typestore
        store=get_typestore(Stores.ROS1_NOETIC)
        T=store.types
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'record.bag'
            with Writer(p) as w:
                s=w.add_connection('/joint_states','sensor_msgs/msg/JointState',typestore=store)
                a=w.add_connection('/joint_commands','sensor_msgs/msg/JointState',typestore=store)
                def msg(names,values):
                    return T['sensor_msgs/msg/JointState'](T['std_msgs/msg/Header'](0,T['builtin_interfaces/msg/Time'](0,0),''),names,np.array(values,dtype=np.float64),np.array([],dtype=np.float64),np.array([],dtype=np.float64))
                w.write(s,1_000_000_000,store.serialize_ros1(msg(['a','b'],[1.,2.]),s.msgtype))
                w.write(a,1_005_000_000,store.serialize_ros1(msg(['b','a'],[2.1,1.1]),a.msgtype))
            data=parse_ros(p,state_topic='/joint_states',action_topic='/joint_commands')
            self.assertEqual(data[0]['joints'][0]['state'],[[0.,1.]])
            self.assertEqual(data[0]['joints'][0]['action'],[[.005,1.1]])
            with self.assertRaisesRegex(ValueError,'可用 Topic'):
                parse_ros(p,state_topic='/missing',action_topic='/joint_commands')
    def test_ros2_sqlite_and_mcap(self):
        import numpy as np
        from rosbags.rosbag2 import Writer
        from rosbags.rosbag2.enums import StoragePlugin
        from rosbags.typesys import Stores,get_typestore
        store=get_typestore(Stores.ROS2_HUMBLE)
        T=store.types
        for plugin in (StoragePlugin.SQLITE3,StoragePlugin.MCAP):
            with self.subTest(plugin=plugin), tempfile.TemporaryDirectory() as d:
                p=Path(d)/'bag'
                with Writer(p,version=9,storage_plugin=plugin) as w:
                    conns=[w.add_connection(topic,'sensor_msgs/msg/JointState',typestore=store) for topic in ['/state','/action']]
                    for i,c in enumerate(conns):
                        msg=T['sensor_msgs/msg/JointState'](T['std_msgs/msg/Header'](T['builtin_interfaces/msg/Time'](0,0),''),['finger'],np.array([.2+i*.1],dtype=np.float64),np.array([],dtype=np.float64),np.array([],dtype=np.float64))
                        w.write(c,1_000_000_000+i*10_000_000,store.serialize_cdr(msg,c.msgtype))
                data=parse_ros(p,state_topic='/state',action_topic='/action')
                self.assertEqual(data[0]['joints'][0]['state'],[[0.,.2]])
                self.assertAlmostEqual(data[0]['joints'][0]['action'][0][1],.3)

    def test_missing_ros2_metadata_is_actionable(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'a.db3').write_bytes(b'')
            options=dict(state_topic='',action_topic='',state_field='position',action_field='position',state_column='observation.state',action_column='action',positional=False,unit='rad')
            with self.assertRaisesRegex(ValueError,'metadata.yaml'):
                parse_upload(Path(d),**options)

if __name__=='__main__':unittest.main()
