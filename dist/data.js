export function normalize(d){if(!d||!Array.isArray(d.joints)||!d.joints.length)throw Error('JSON 需要非空 joints 数组');const names=new Set();let min=Infinity,max=-Infinity;const joints=d.joints.map(j=>{if(typeof j.name!=='string'||!j.name.trim()||names.has(j.name))throw Error('关节名称缺失或重复');names.add(j.name);const clean=key=>{if(j[key]!==undefined&&!Array.isArray(j[key]))throw Error(`${j.name}.${key} 必须为 [time,value] 数组`);const pts=(j[key]||[]).map(p=>{if(!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error(`${j.name}.${key} 含无效数值`);min=Math.min(min,p[0]);max=Math.max(max,p[0]);return [...p]}).sort((a,b)=>a[0]-b[0]);return pts};const state=clean('state'),action=clean('action');if(!state.length&&!action.length)throw Error(`${j.name} 无数据`);return {...j,unit:typeof j.unit==='string'?j.unit:'unitless',state,action}});return {...d,joints,min,max:max===min?min+.001:max}}
export function nearest(points,t){if(!points.length)return null;let lo=0,hi=points.length;while(lo<hi){const mid=(lo+hi)>>>1;if(points[mid][0]<t)lo=mid+1;else hi=mid}const a=points[Math.max(0,lo-1)],b=points[Math.min(points.length-1,lo)];return Math.abs(a[0]-t)<=Math.abs(b[0]-t)?a:b}
export function metrics(j,start,end,tolerance){let sum=0,max=0,count=0;for(const [t,s]of j.state){if(t<start||t>end)continue;const a=nearest(j.action,t);if(!a||a[0]<start||a[0]>end||Math.abs(a[0]-t)>tolerance+1e-12)continue;const e=Math.abs(s-a[1]);sum+=e;max=Math.max(max,e);count++}return {mae:count?sum/count:null,max:count?max:null,count}}
function rows(text){const result=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else if(!field||quoted)quoted=!quoted;else throw Error('CSV 引号格式错误')}else if(c===','&&!quoted){row.push(field);field=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))result.push(row);row=[];field=''}else field+=c}if(quoted)throw Error('CSV 引号未闭合');row.push(field);if(row.some(x=>x.trim()))result.push(row);return result}
export function parseCSV(text){const all=rows(text.replace(/^\uFEFF/,''));if(all.length<2)throw Error('CSV 没有数据行');const header=all.shift().map(s=>s.trim()),idx=k=>header.indexOf(k);for(const key of ['time','joint'])if(idx(key)<0)throw Error(`CSV 缺少 ${key} 列`);if(idx('state')<0&&idx('action')<0)throw Error('CSV 需要 state 或 action 列');const map=new Map();for(const [i,row]of all.entries()){if(row.length!==header.length)throw Error(`第 ${i+2} 行列数不一致`);const name=row[idx('joint')].trim(),time=row[idx('time')].trim();if(!name||!time||!Number.isFinite(+time))throw Error(`第 ${i+2} 行时间或关节名称无效`);const unit=idx('unit')<0?'unitless':row[idx('unit')].trim()||'unitless';if(!map.has(name))map.set(name,{name,unit,state:[],action:[]});const j=map.get(name);if(j.unit!==unit)throw Error(`${name} 的单位不一致`);for(const key of ['state','action']){const col=idx(key);if(col<0||!row[col].trim())continue;const v=+row[col];if(!Number.isFinite(v))throw Error(`第 ${i+2} 行 ${key} 数值无效`);j[key].push([+time,v])}}return normalize({joints:[...map.values()]})}
const fingerNames = {
  thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', pinky: '小指', little: '小指'
};
const fingerJoints = {
  cmc: '腕掌关节', mcp: '掌指关节', pip: '近端指间关节', dip: '远端指间关节', ip: '指间关节',
  root1: '指根第 1 关节', root2: '指根第 2 关节', tip: '指尖关节',
  roll: '滚转关节', yaw: '偏航关节'
};
const jointMotions = {
  fe: '屈伸', flex: '屈伸', aa: '内收/外展', abd: '内收/外展'
};

export function fingerJointNote(name, group) {
  const joint = name.split('/').at(-1).toLowerCase().replace(/\.(position|command)$/, '');
  const match = /^(?:(left|right|l|r)_)?(?:hand_)?(thumb|index|middle|ring|pinky|little)(?:_finger)?_(cmc|mcp|pip|dip|ip|root1|root2|tip|roll|yaw|\d+)(?:_(fe|aa|flex|abd))?$/.exec(joint);
  if (!match) return '';

  const [, side, finger, part, motion] = match;
  const hand = side ? (side.startsWith('l') ? '左手' : '右手')
    : ({ left_hand: '左手', right_hand: '右手' }[group] || '');
  const position = fingerJoints[part] || `第 ${part} 关节`;
  return `${hand}${fingerNames[finger]} · ${position}${motion ? `（${jointMotions[motion]}）` : ''}`;
}

export const diagnosisLimits = { coverage: 0.95, maeDegrees: 5, maxDegrees: 15 };
const degreesPerUnit = new Map([['rad', 180 / Math.PI], ['deg', 1], ['°', 1]]);

export function diagnoseEpisode(dataset, tolerance) {
  const findings = [];
  const { coverage, maeDegrees, maxDegrees } = diagnosisLimits;
  let highErrorCount = 0;
  let incompleteCount = 0;

  for (const joint of dataset.joints) {
    const reasons = [];
    let highError = false;
    if (!joint.state.length || !joint.action.length) {
      reasons.push(joint.state.length ? '缺少 Action' : '缺少 State');
    } else {
      const { count, mae, max } = metrics(joint, dataset.min, dataset.max, tolerance);
      const matched = count / joint.state.length;
      const scale = degreesPerUnit.get(joint.unit.trim().toLowerCase());
      if (matched < coverage) {
        reasons.push(`配对率偏低（${count}/${joint.state.length} 个 State 样本）`);
      }
      if (count < 2) {
        reasons.push(count ? '仅 1 个有效配对' : '无有效配对');
      } else if (scale === undefined) {
        reasons.push(`单位 ${joint.unit || '未填写'}，无法应用角度阈值`);
      } else {
        const mean = mae * scale;
        const peak = max * scale;
        highError = mean > maeDegrees || peak > maxDegrees;
        if (highError) {
          reasons.push(`误差超限（MAE ${mean.toFixed(2)}°，MAX ${peak.toFixed(2)}°）`);
        }
      }
    }

    if (reasons.length) findings.push({ name: joint.name, reasons });
    if (highError) highErrorCount++;
    else if (reasons.length) incompleteCount++;
  }

  return {
    findings,
    highErrorCount,
    incompleteCount,
    passedCount: dataset.joints.length - findings.length
  };
}
