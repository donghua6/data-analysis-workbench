# 数据分析工作台

面向机器人采集数据的本地分析工具。按关节名称读取实际状态与绝对动作目标，结合三路 RGB 视频在同一时间轴回放，提供关节位置对比、误差统计和 JSON 导出。

```text
LeRobot / ROS bag / CSV / JSON → 关节名称映射 → episode 独立加载 → 相机与曲线同步回放 → 误差统计 / JSON 导出
```

原始数据只读访问，不修改采集文件。关节分析和视频回放在本机运行，不依赖训练环境。

## 支持功能

- 按左臂、右臂、左手、右手选择关节；支持全部选择 / 取消、名称搜索和图表展开。
- State / Action 同轴对比，显示 MAE、MAX 和有效配对数量。
- LeRobot 数据集按 episode 读取，支持一套目录包含多条录制及上级目录扫描。
- 三路相机统一播放、暂停、倍速与进度定位；拖动关节图游标同步定位视频。
- 导出已选关节的 JSON 数据，支持再次导入。
- 已适配天机臂、FR3、UR、Sharpa、Wuji 相关数据命名。

本项目用于离线数据检查，不控制机器人。相机与关节按数据集时间轴回放，不改写原始采样时间。

## 支持范围

| 数据类型 / 本体 | 支持内容 |
| --- | --- |
| LeRobot v2.1 | 元数据、逐 episode Parquet 与三路 MP4；实际目录导入已验证 |
| LeRobot v3 | 支持元数据中的数据 / 视频分片索引及时间偏移；未覆盖所有变体 |
| 双 FR3 + Wuji | 常见 State 108D / Action 54D，提取 54 个位置关节 |
| 双 FR3 / 天机臂 + Sharpa | 常见 State 116D / Action 58D，提取 58 个位置关节 |
| 双 UR + O30 | 已验证 52D State / 12D Action，保留仅 State 的 40 个手部关节 |
| ROS1 / ROS2 | JointState 等可映射关节消息；ROS2 需完整 metadata.yaml 与存储文件 |
| CSV / JSON | 关节长表或 joints 数组，支持只有单侧数据 |

本体名称和维度仅描述已验证数据，不根据维度猜测关节映射。深度、触觉、力矩与接管状态尚无专用可视化。

## 环境要求

- Linux / macOS，Python 3.12 为已验证环境。
- 浏览器支持 H.264 视频解码。
- Node.js 仅用于前端测试，运行服务不依赖 Node.js。
- 共享数据目录须挂载至运行服务的主机，并具备读取权限。

## 安装与启动

```bash
git clone ssh://git@gitlab.litchibot.top:2222/fruit-infra/data-processing/data-analysis-workbench.git
cd data-analysis-workbench
```

在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
bash start_analysis.sh
```

浏览器访问 http://127.0.0.1:8877/ 。服务仅监听本机。8877 为分析工作台端口，8765 保留给数据清洗工作流。

完整锁定依赖安装不兼容时，可使用 requirements.txt 中的兼容范围安装并重新测试。

## 导入与字段配置

点击“导入数据”，在“直接读取采集目录 / LeRobot”填写绝对路径，扫描目录后选择 episode，点击“导入关节数据”。数据导入完成后，勾选需要查看的关节。

LeRobot 目录示例：

```text
dataset/
├── meta/
│   ├── info.json
│   └── episodes.jsonl
├── data/chunk-000/episode_000000.parquet
└── videos/chunk-000/<camera>/episode_000000.mp4
```

大数据使用路径导入，不复制或上传整个数据集。只加载所选 episode 的关节数据，视频按需读取。文件上传上限 512 MB；解析上限 200 万标量点。

| 配置项 | 用途 |
| --- | --- |
| 目录路径 | 运行服务的主机可访问的绝对路径或已挂载 SFTP 地址 |
| State / Action 列 | LeRobot 默认 observation.state / action |
| State / Action Topic | ROS 手动模式指定不同的状态与目标话题 |
| 字段 | ROS 默认 position，支持点分隔属性路径 |
| 单位 | State / Action 共同单位，默认 rad，须核对源数据 |
| 按索引匹配 | 仅在已确认同维度、同顺序和同物理含义后显式启用 |

State / Action 按关节名称对应；包含位置和速度的 State 只提取已识别的位置维度。Action 只覆盖部分关节时，保留其他关节 State，不生成缺失目标值。单位应与源数据一致。

使用 samples/episode_demo 的绝对路径可验证 ROS2 示例导入。samples 内均为模拟数据，不包含实际采集数据。

## 操作说明

- 点击“全部关节”展示所有关节，再次点击取消全部；未勾选时不显示图表。
- 点击臂 / 手分组整组选择，也可跨组勾选单个关节。
- 数据名称下方选择框切换 episode，切换后重新选择关节。
- 相机进度条或关节图竖向虚线均可拖动定位，三路视频和图表同步更新。
- 拖动时暂停播放，松手停在所选帧，继续播放需点击“播放”。
- 绿色实线为 State，紫色虚线为 Action；容差内最近邻匹配计算误差，不插值。无有效配对显示“—”。

详细说明见 [使用手册](docs/user-guide.md)。Rerun 为独立的 RRD 查看入口，未实现与工作台同步的 URDF 三维姿态回放。

## 项目结构

```text
server.py               本地 API、格式解析与服务入口
capture_import.py       ROS2 采集目录发现和读取
lerobot_local.py        LeRobot episode 发现、时间轴与视频资源
start_analysis.sh       启动脚本
dist/                   原生 HTML / CSS / JavaScript 前端
samples/                模拟 CSV 和 ROS2 采集示例
tests/                  Python 与 JavaScript 测试
docs/user-guide.md      操作手册
requirements.lock.txt   已验证的完整依赖版本
```

前端无构建步骤，服务直接提供 dist/ 静态文件。

## 测试

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.js
```

当前 14 项 Python、7 项 JavaScript 测试通过。测试覆盖名称映射、episode 隔离、仅 State 关节、ROS 导入和逐帧时间定位；不代表所有实际录制均完成质量检查。

## 输出与时间口径

导出为已选且符合搜索条件关节的 JSON，包含原始单位的 State / Action。当前展示与导出范围为整条 episode，拖动游标不裁剪数据，不打包相机视频。JSON 可再次导入。

MAE / MAX 以 State 时间为基准寻找容差内最近的 Action 样本，默认 30 ms，不做插值。图表显示抽稀，统计使用完整范围数据。缺少 Action 时显示“—”，不按零误差处理。

LeRobot 以逐帧 timestamp 定位；source_timestamp_ns 以字符串保留，避免 JavaScript 纳秒整数精度损失。同步回放不代表原始相机曝光时刻完全一致。ROS 默认使用 bag 记录时间，alignment 模式使用明确支持的源时间契约。

## 常见问题

- 无法连接 / Failed to fetch：检查 8877 服务是否运行，启动后刷新页面。
- Input/output error / Errno 5：检查内网连接和共享挂载；先恢复目录读取，再重新扫描。
- 导入后没有图：检查关节勾选与搜索条件。
- MAE / MAX 为“—”：检查 Action 是否存在，或匹配容差内是否有对应采样。
- 视频加载失败：检查当前 episode 视频文件、挂载状态及浏览器编码支持。
- 名称 / 维度不匹配：核对 meta/info.json、数据列名及动作物理含义，不强制按索引配对不同关节空间。
