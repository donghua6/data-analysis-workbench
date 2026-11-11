import {frameAt,mediaTime} from './time.js?v=fedd1dfde997';
import {normalize,parseCSV,metrics,nearest,fingerJointNote,diagnoseEpisode,diagnosisLimits} from './data.js?v=272d6521e935';
const $=id=>document.getElementById(id), esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let dataset,selected=new Set(),filter='all',query='',limit=4,start=0,end=24,cursor=null,busy=false,service=false,episodes=[];
let focusedJoint = null;
function demo(){const names=[];for(const side of ['left','right'])for(let i=1;i<=7;i++)names.push(`${side}_arm_joint_${i}`);for(const side of ['left','right'])for(const finger of ['thumb','index','middle','ring','little'])for(let i=1;i<=2;i++)names.push(`${side}_hand_${finger}_${i}`);return {name:'tianji_shaper_pick_place',demo:true,joints:names.map((name,j)=>({name,unit:'rad',state:Array.from({length:2401},(_,i)=>{const t=i/100;return [t,signal(t-.075,j)+.012*Math.sin(t*9+j)]}),action:Array.from({length:1201},(_,i)=>[i/50,signal(i/50,j)])}))}}
function signal(t,j){return .48*Math.sin(t*.45+j*.41)+.15*Math.sin(t*1.1+j*.8)+.06*Math.cos(t*2+j)+((j%7)-3)*.11}
const groupName=g=>({'left_arm':'左机械臂','right_arm':'右机械臂','left_hand':'左灵巧手','right_hand':'右灵巧手','other':'其他关节','all':'全部关节'}[g]||g);
function group(j){return j.group||(['left_arm','right_arm','left_hand','right_hand'].find(g=>j.name.includes(g))||'other')}
function setData(d){dataset=normalize(d);dataset.demo=!!d.demo;document.querySelector('.side-caption .badge').textContent=d.demo?'示例':'导入';document.querySelector('.robot-name>div').innerHTML=d.demo?'天机臂 + Shaper 双手<small>可通过导入数据替换关节</small>':'已导入的机器人关节<small>按 Topic / 关节名称自动分组</small>';dataset.name=d.name||'Imported recording';$('datasetName').title=d.source_path||dataset.name;selected=new Set();focusedJoint=null;filter='all';query='';$('search').value='';limit=+$('pageSize').value;start=dataset.min;end=dataset.max;cursor=null;$('datasetName').textContent=dataset.name;$('sampleTag').textContent=d.demo?'示例数据':'已导入';$('datasetMeta').textContent=d.demo?'确定性模拟 · State 100 Hz / Action 50 Hz':(d.episode_count?`${d.robot_type||'LeRobot'} · 共 ${d.episode_count} 条 episode · 当前 ${d.episode_index}${d.channel_summary?.state_only?` · ${d.channel_summary.paired} 个可对比 / ${d.channel_summary.state_only} 个仅 State`:''}`:'原始时间戳 · 关节与单位来自导入数据');$('durationStat').innerHTML=`${(end-start).toFixed(2)} <em>s</em>`;$('jointStat').innerHTML=`${dataset.joints.length} <em>joints</em>`;$('pointsStat').textContent=dataset.joints.reduce((n,j)=>n+j.state.length+j.action.length,0).toLocaleString();$('footerText').textContent=d.demo?'示例关节配置 · 不代表实际硬件关节数量与运动学':'原始采样时间绘图 · 容差内最近邻匹配，仅计算同时存在的数值';renderTree();render();setupCameras(d);renderDiagnosis()}
function renderDiagnosis() {
  const toleranceMs = $('tolerance').valueAsNumber;
  const { findings, highErrorCount, incompleteCount, passedCount } = diagnoseEpisode(dataset, toleranceMs / 1000);
  const { coverage, maeDegrees, maxDegrees } = diagnosisLimits;
  const panel = $('episodeDiagnosis');
  panel.dataset.result = highErrorCount ? 'warning' : incompleteCount ? 'incomplete' : 'pass';
  $('diagnosisVerdict').textContent = highErrorCount ? '发现跟踪误差超限'
    : incompleteCount ? '有数据问题或无法完整判断' : '按当前规则未发现问题';
  $('diagnosisSummary').textContent = [
    `通过 ${passedCount}/${dataset.joints.length} 个关节`,
    highErrorCount ? `误差超限 ${highErrorCount} 个` : '',
    incompleteCount ? `数据不足或未判定 ${incompleteCount} 个` : ''
  ].filter(Boolean).join(' · ');
  $('diagnosisRules').textContent = `整条 episode · 时间匹配容差 ${toleranceMs} ms · State 配对率 ≥ ${coverage * 100}% 且至少 2 对 · MAE ≤ ${maeDegrees}° · MAX ≤ ${maxDegrees}°`;
  $('diagnosisDetails').hidden = !findings.length;
  $('diagnosisDetails').open = false;
  $('diagnosisJoints').innerHTML = findings.map(({ name, reasons }) =>
    `<li><button type="button" class="diagnosis-joint-link" data-chart-joint="${esc(name)}" aria-label="查看 ${esc(name)} 的折线图">${esc(name)} <span aria-hidden="true">↗</span></button> ${esc(reasons.join(' · '))}</li>`
  ).join('');
}

$('diagnosisJoints').onclick = event => {
  const button = event.target.closest('button[data-chart-joint]');
  if (!button) return;

  const name = button.dataset.chartJoint;
  selected.add(name);
  focusedJoint = name;
  if (!name.toLowerCase().includes(query)) {
    query = '';
    $('search').value = '';
  }
  limit = Math.max(1, limit);
  renderTree();
  render();

  const card = $('charts').firstElementChild;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'start' });
};

function renderJointCheck(joint, group) {
  const name = esc(joint.name.replace(`${group}_`, ''));
  const note = fingerJointNote(joint.name, group);
  const annotation = note ? ` <span class="joint-note">${esc(note)}</span>` : '';
  return `<label class="joint-check"><input type="checkbox" data-joint="${esc(joint.name)}" ${selected.has(joint.name) ? 'checked' : ''}><span>${name}${annotation}</span></label>`;
}
function renderTree(){const groups=[...new Set(dataset.joints.map(group))];$('tree').innerHTML=`<div class="tree-group"><button data-group="all" class="${selected.size===dataset.joints.length?'active':''}">⌘ 全部关节 <small>${dataset.joints.length}</small></button></div>`+groups.map(g=>{const js=dataset.joints.filter(j=>group(j)===g);return `<div class="tree-group"><button data-group="${esc(g)}" class="${js.every(j=>selected.has(j.name))?'active':''}">⌄ ${esc(groupName(g))}<small>${js.length.toString().padStart(2,'0')}</small></button><div class="tree-children">${js.map(j=>renderJointCheck(j,g)).join('')}</div></div>`}).join('');$('tree').querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>{const g=b.dataset.group;if(g==='all'){selected=selected.size===dataset.joints.length?new Set():new Set(dataset.joints.map(j=>j.name));query='';$('search').value=''}else{const names=dataset.joints.filter(j=>group(j)===g).map(j=>j.name);const remove=names.every(n=>selected.has(n));names.forEach(n=>remove?selected.delete(n):selected.add(n))}filter='all';limit=selected.size;renderTree();render()});$('tree').querySelectorAll('[data-joint]').forEach(i=>i.onchange=()=>{i.checked?selected.add(i.dataset.joint):selected.delete(i.dataset.joint);limit=selected.size;renderTree();render()})}
function visible(){return dataset.joints.filter(j=>selected.has(j.name)&&(!query||j.name.toLowerCase().includes(query)))}
function displayedJoints(joints) {
  const index = joints.findIndex(joint => joint.name === focusedJoint);
  if (index > 0) joints.unshift(...joints.splice(index, 1));
  return joints.slice(0, limit);
}
function factor(j){return $('unit').value==='deg'&&j.unit==='rad'?180/Math.PI:1}function unit(j){return factor(j)!==1?'°':j.unit}
function viewValues(j){return [...j.state,...j.action].filter(p=>p[0]>=start&&p[0]<=end).map(p=>p[1]*factor(j))}
function path(points,x,y,max=1300){const inWindow=points.filter(p=>p[0]>=start&&p[0]<=end),step=Math.max(1,Math.ceil(inWindow.length/max));return inWindow.filter((_,i)=>i%step===0||i===inWindow.length-1).map((p,i)=>`${i?'L':'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ')}
function timeFmt(t,span){return t.toFixed(Math.max(1,Math.min(6,Math.ceil(-Math.log10(Math.max(span/8,1e-6)))+1)))}
function chart(j,index){const note = fingerJointNote(j.name, group(j));
const w=540,h=190,l=48,r=16,t=15,b=30,vals=viewValues(j),f=factor(j);let lo=vals.length?Math.min(...vals.filter((_,i)=>i%Math.max(1,Math.ceil(vals.length/10000))===0)):-1,hi=vals.length?Math.max(...vals.filter((_,i)=>i%Math.max(1,Math.ceil(vals.length/10000))===0)):1;const pad=Math.max((hi-lo)*.18,.02);lo-=pad;hi+=pad;const x=v=>l+(v-start)/(end-start)*(w-l-r),y=v=>t+(hi-v*f)/(hi-lo)*(h-t-b);const ticks=Array.from({length:5},(_,i)=>{const yy=t+i*(h-t-b)/4;return `<line x1="${l}" x2="${w-r}" y1="${yy}" y2="${yy}" stroke="#edf1eb" stroke-dasharray="3 4"/><text x="${l-10}" y="${yy+3}" text-anchor="end" fill="#a0ad9b" font-size="8">${(hi-i*(hi-lo)/4).toFixed(2)}</text>`}).join('');const xticks=Array.from({length:7},(_,i)=>{const v=start+i*(end-start)/6;return `<text x="${x(v)}" y="${h-10}" text-anchor="middle" fill="#a0ad9b" font-size="8">${timeFmt(v,end-start)}</text>`}).join('');const m=metrics(j,start,end,+$('tolerance').value/1000),v=n=>n===null?'—':(n*f).toFixed(4);const cx=cursor===null?null:x(cursor);return `<article class="chart-card" tabindex="-1" aria-labelledby="chart-title-${index}"><div class="chart-head"><span class="joint-index">${String(index+1).padStart(2,'0')}</span><div><h3 id="chart-title-${index}" title="${esc(j.name)}">${esc(j.name)}</h3><small>${esc(groupName(group(j)))}</small>${note ? `<small class="chart-joint-note">${esc(note)}</small>` : ''}</div><span class="joint-unit">${esc(unit(j))}</span></div><svg class="chart-svg" data-name="${esc(j.name)}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(j.name)} 的 state/action 对比图"><defs><clipPath id="clip${index}"><rect x="${l}" y="${t}" width="${w-l-r}" height="${h-t-b}"/></clipPath></defs><g font-family="IBM Plex Mono,monospace">${ticks}${xticks}<g clip-path="url(#clip${index})">${$('showAction').checked?`<path d="${path(j.action,x,y)}" fill="none" stroke="#8394d8" stroke-width="1.7" stroke-dasharray="5 4"/>`:''}${$('showState').checked?`<path d="${path(j.state,x,y)}" fill="none" stroke="#438a62" stroke-width="1.8"/>`:''}</g><g class="cursor-layer">${cx!==null?`<line x1="${cx}" x2="${cx}" y1="${t}" y2="${h-b}" stroke="#859782" stroke-dasharray="3 3"/><text x="${Math.min(w-205,Math.max(l,cx+7))}" y="${t+8}" class="hover-tooltip">${cursor.toFixed(3)}s · S ${read(j.state,cursor,f)} / A ${read(j.action,cursor,f)}</text>`:''}</g><text x="${w-4}" y="${h-10}" fill="#9eab99" font-size="8">s</text>${vals.length===0?`<text x="270" y="90" text-anchor="middle" fill="#9aa894" font-size="11">此时间窗口无数据</text>`:''}</g></svg><div class="chart-bottom"><span>MAE<strong>${v(m.mae)}</strong></span><span>MAX<strong>${v(m.max)}</strong></span><span>配对 ${m.count.toLocaleString()} · ${esc(unit(j))}</span></div></article>`}
function read(points,t,f){const p=nearest(points,t);return p&&Math.abs(p[0]-t)<=+$('tolerance').value/1000?(p[1]*f).toFixed(3):'—'}
function render(){const js=visible(),shown=displayedJoints(js);$('countLabel').textContent=`${shown.length} / ${dataset.joints.length}`;$('groupTitle').textContent=groupName(filter);$('groupSubtitle').textContent=selected.size?`已选择 ${selected.size} 个关节`:'未选择关节';$('charts').innerHTML=shown.map(chart).join('');$('empty').hidden=!!js.length;const remaining=js.length-shown.length;$('moreBtn').hidden=remaining<=0;$('moreBtn').textContent=`⌄ 展开其余 ${remaining} 个已选关节`;$('charts').querySelectorAll('svg').forEach(svg=>{svg.onpointermove=e=>{if(svg.dataset.scrubbing==='true'){scrubChart(svg,e);return}if(cameraVideos.length)return;const r=svg.getBoundingClientRect(),xx=(e.clientX-r.left)/r.width*540;cursor=start+Math.max(0,Math.min(1,(xx-48)/(540-64)))*(end-start);requestAnimationFrame(()=>{if(cursor!==null)renderCursor()})};svg.onpointerleave=()=>{if(svg.dataset.scrubbing==='true')return;cursor=cameraVideos.length?+$('cameraSeek').value:cursor;renderCursor()};svg.onpointerdown=e=>{if(e.button!==0||!e.isPrimary)return;e.preventDefault();pauseCameras();svg.dataset.scrubbing='true';svg.classList.add('scrubbing');svg.setPointerCapture(e.pointerId);scrubChart(svg,e)};svg.onpointerup=e=>{if(svg.dataset.scrubbing!=='true')return;scrubChart(svg,e);finishScrub(svg,e)};svg.onpointercancel=e=>finishScrub(svg,e);svg.onlostpointercapture=()=>{svg.dataset.scrubbing='false';svg.classList.remove('scrubbing')}})}
let frame=false;function renderCursor(){if(frame)return;frame=true;requestAnimationFrame(()=>{frame=false;const js=displayedJoints(visible());$('charts').querySelectorAll('svg .cursor-layer').forEach((layer,i)=>{const j=js[i];if(cursor===null){layer.innerHTML='';return}const cx=48+(cursor-start)/(end-start)*476;layer.innerHTML=`<line x1="${cx}" x2="${cx}" y1="15" y2="160" stroke="#859782" stroke-dasharray="3 3"/><text x="${Math.min(335,Math.max(48,cx+7))}" y="23" class="hover-tooltip">${cursor.toFixed(3)}s · S ${read(j.state,cursor,factor(j))} / A ${read(j.action,cursor,factor(j))}</text>`})})}
function toast(s){$('toast').textContent=s;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),3200)}
function download(text,name,type='application/json'){const u=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function showImport(){$('importDialog').showModal()}for(const id of ['importBtn','railImport'])$(id).onclick=showImport;for(const id of ['sideRerun','railRerun'])$(id).onclick=()=>$('rerunDialog').showModal();$('helpBtn').onclick=()=>window.open('README.md','_blank');$('demoBtn').onclick=()=>{removeEpisodes();setData(demo());toast('已加载示例数据')};$('search').oninput=e=>{query=e.target.value.toLowerCase();render()};$('pageSize').onchange=()=>{limit=+$('pageSize').value;render()};$('expandAll').onclick=()=>{limit=selected.size;render()};$('moreBtn').onclick=()=>{limit=visible().length;render()};for(const id of ['showState','showAction','unit'])$(id).onchange=render;
$('tolerance').onchange=()=>{
  const tolerance = $('tolerance');
  if (!Number.isFinite(tolerance.valueAsNumber) || tolerance.valueAsNumber < 0) tolerance.value = tolerance.defaultValue;
  renderDiagnosis();
  render();
};
$('exportBtn').onclick=()=>{const js=visible(),joints=js.map(j=>({...j,state:j.state.filter(p=>p[0]>=start&&p[0]<=end),action:j.action.filter(p=>p[0]>=start&&p[0]<=end)})).filter(j=>j.state.length||j.action.length);if(!joints.length)return toast('当前时间窗口没有可导出的数据');download(JSON.stringify({name:dataset.name,window:[start,end],joints},null,2),'jointscope-selection.json');toast(`已导出 ${joints.length} 个关节的原始单位数据`)};$('templateBtn').onclick=()=>download('time,joint,state,action,unit\n0,left_arm_joint_1,0.12,0.15,rad\n0.01,left_arm_joint_1,0.14,0.16,rad\n','jointscope-template.csv','text/csv');$('folderBtn').onclick=()=>$('folderInput').click();$('fileInput').onchange=e=>importFiles([...e.target.files]);$('folderInput').onchange=e=>importFiles([...e.target.files]);for(const type of ['dragover','dragleave','drop'])$('dropZone').addEventListener(type,e=>{e.preventDefault();$('dropZone').classList.toggle('dragover',type==='dragover');if(type==='drop')importFiles([...e.dataTransfer.files])});
function log(s){$('importLog').hidden=false;$('importLog').textContent=s}function removeEpisodes(){document.getElementById('episodeSelect')?.remove();episodes=[]}
function installEpisodes(items){removeEpisodes();episodes=items;if(items.length>1){const sel=document.createElement('select');sel.id='episodeSelect';sel.setAttribute('aria-label','选择 episode');items.forEach((d,i)=>{const op=document.createElement('option');op.value=i;op.textContent=d.name;sel.append(op)});sel.onchange=()=>setData(episodes[+sel.value]);$('datasetName').parentElement.append(sel)}setData(items[0])}
async function importFiles(files){if(!files.length||busy)return;if(files.some(f=>f.name.endsWith('.parquet')))files=files.filter(f=>f.name.endsWith('.parquet')&&!((f.webkitRelativePath||f.name).split('/').includes('meta'))||f.name==='info.json');busy=true;log('正在解析，请稍候…');try{let result;const f=files[0],ext=f.name.split('.').pop().toLowerCase();if(files.length===1&&['csv','json'].includes(ext)){const txt=await f.text();const raw=ext==='csv'?parseCSV(txt):JSON.parse(txt);if(ext==='json'&&!Array.isArray(raw.joints))throw Error('这份 JSON 是采集配置或校验信息，不是关节数据。请选择整个采集目录，或使用上方目录路径扫描。');result={datasets:[{...raw,name:raw.name||f.name}]}}else{if(files.reduce((n,f)=>n+f.size,0)>512*1024*1024)throw Error('目录超过 512 MB。请使用上方“直接读取采集目录”，粘贴本机或已挂载共享目录地址，无需上传整个 bag。');if(!service)throw Error('ROS / LeRobot 需要本地解析服务。请在项目目录执行 python server.py，并在 http://localhost:8877 重新导入。');const form=new FormData();for(const file of files)form.append('files',file,file.webkitRelativePath||file.name);for(const [key,id]of [['state_topic','stateTopic'],['action_topic','actionTopic'],['state_field','stateField'],['action_field','actionField'],['state_column','stateColumn'],['action_column','actionColumn'],['unit','importUnit']])form.append(key,$(id).value);form.append('positional',$('positional').checked?'true':'false');const r=await fetch('/api/import',{method:'POST',body:form});result=await r.json();if(!r.ok)throw Error(result.detail||'解析失败')}if(!result.datasets?.length)throw Error('没有可用 episode');result.datasets.forEach(normalize);installEpisodes(result.datasets);$('importDialog').close();toast(`已导入 ${result.datasets.length} 个 episode`)}catch(e){log(`导入失败：${e.message}`)}finally{busy=false;$('fileInput').value='';$('folderInput').value=''}}
$('loadRerun').onclick=()=>{const version=$('rerunVersion').value.trim(),url=$('rrdUrl').value.trim();if(!/^\d+\.\d+\.\d+$/.test(version))return toast('请输入正确的 SDK 版本，如 0.20.3');if(url){try{if(!['http:','https:'].includes(new URL(url).protocol))throw Error()}catch{return toast('请输入 http(s) 格式的 RRD URL')}}const target=`https://app.rerun.io/version/${version}/?theme=light${url?'&url='+encodeURIComponent(url):''}`;window.open(target,'_blank','noopener,noreferrer')};document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;if(e.key.toLowerCase()==='i'&&!e.ctrlKey&&!e.metaKey&&!document.querySelector('dialog[open]'))showImport();if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();$('search').focus()}});fetch('/api/health').then(r=>r.ok?r.json():null).then(d=>{if(d?.service==='jointscope'){service=true;$('serviceStatus').textContent='本地解析服务已连接'}}).catch(()=>{});
let localRecordings=[],scannedPath='',captureService=false,activeLocalRecording=-1;
function localOptions(){return {state_column:$('stateColumn').value,action_column:$('actionColumn').value,path:scannedPath,recording:+$('recordingSelect').value,auto:$('autoCapture').checked,aligned:$('alignCapture').checked,state_topic:$('stateTopic').value,action_topic:$('actionTopic').value,state_field:$('stateField').value,action_field:$('actionField').value,positional:$('positional').checked,unit:$('importUnit').value}}
async function localAPI(endpoint,payload){let r;try{r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})}catch{throw Error('无法连接本地解析服务（8877）。请在项目目录运行 ./start_analysis.sh，服务启动后重新扫描。')}const d=await r.json();if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:'解析失败');return d}
function showRecording(){const d=localRecordings[+$('recordingSelect').value];const lerobot=d.kind==='lerobot';$('autoCapture').parentElement.hidden=lerobot;$('alignCapture').parentElement.hidden=lerobot;if(lerobot){$('pairSummary').textContent=`${d.frames??'—'} 帧 · ${d.fps??'—'} fps · ${d.cameras.length} 路相机`;log(`已找到 ${d.dataset_name||'LeRobot 数据集'}，共 ${d.episode_count||localRecordings.length} 条 episode。选择一条导入，之后可在主界面切换。`);return;}$('pairSummary').innerHTML=d.pairs.length?d.pairs.map(p=>`<div class="pair-row">${esc(groupName(p.group))}<small>${esc(p.state)} ↔ ${esc(p.action)}</small></div>`).join(''):`未检测到可自动匹配的关节 Topic，请展开下方配置并手动选择。`;$('rosTopics').innerHTML=d.topics.map(t=>`<option value="${esc(t.name)}">${esc(t.type)} · ${t.count} 条</option>`).join('');$('autoCapture').checked=!!d.pairs.length;log(`已找到 ${d.topics.length} 个 Topic，${d.pairs.length} 组可配对关节流。确认后点击“导入关节数据”。`);if(!d.pairs.length)document.querySelector('.mapping-details').open=true}
$('recordingSelect').onchange=showRecording;
$('scanLocal').onclick=async()=>{if(busy)return;if(!service){$('localOnlyHint').hidden=false;return log('请先启动本机服务，并在 http://localhost:8877 使用采集目录导入。在线预览不能访问本机文件系统。')}if(!captureService)return log('本机服务仍是旧版本，请在原终端按 Ctrl+C 后重新执行 .venv/bin/python server.py，再刷新页面。');busy=true;$('scanLocal').disabled=true;$('localResults').hidden=true;log('正在扫描目录与 Topic…');try{const path=$('localPath').value.trim(),result=await localAPI('/api/local-inspect',{path});localRecordings=result.recordings;scannedPath=path;$('recordingSelect').innerHTML=localRecordings.map((d,i)=>`<option value="${i}">${esc(d.name)}</option>`).join('');$('localResults').hidden=false;showRecording()}catch(e){log('扫描失败：'+e.message)}finally{busy=false;$('scanLocal').disabled=false}};
$('loadLocal').onclick=async()=>{if(busy)return;if($('localPath').value.trim()!==scannedPath)return log('目录地址已修改，请先重新扫描');busy=true;$('loadLocal').disabled=true;$('scanLocal').disabled=true;if($('episodeSelect'))$('episodeSelect').disabled=true;$('episodeDiagnosis').classList.add('diagnosis-loading');log('正在读取当前录制的关节数据与相机信息，共享目录可能需要一些时间…');try{const result=await localAPI('/api/local-import',localOptions());result.datasets.forEach(normalize);installEpisodes(result.datasets);activeLocalRecording=+$('recordingSelect').value;$('importDialog').close();localStorage.setItem('jointscope.localSource',JSON.stringify(localOptions()));installLocalEpisodeSelect();const count=result.datasets.reduce((n,d)=>n+(d.warnings?.length||0),0);toast(count?'已导入；部分关节仅有单侧数据，详情见数据摘要':'已导入采集目录全部关节')}catch(e){log('导入失败：'+e.message);toast('导入失败：'+e.message);if($('episodeSelect'))$('episodeSelect').value=String(activeLocalRecording)}finally{busy=false;$('episodeDiagnosis').classList.remove('diagnosis-loading');$('loadLocal').disabled=false;$('scanLocal').disabled=false;if($('episodeSelect'))$('episodeSelect').disabled=false}};
$('localPath').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('scanLocal').click()}};
fetch('/api/health').then(r=>r.ok?r.json():null).then(d=>{captureService=d?.capabilities?.includes('capture_directory')||false;$('localOnlyHint').hidden=d?.service==='jointscope'}).catch(()=>$('localOnlyHint').hidden=false);

function installLocalEpisodeSelect(){
 document.getElementById('episodeSelect')?.remove();
 if(localRecordings.length<2)return;
 const sel=document.createElement('select');sel.id='episodeSelect';sel.setAttribute('aria-label','选择本地 episode');
 localRecordings.forEach((d,i)=>{const op=document.createElement('option');op.value=i;op.textContent=d.name;sel.append(op)});
 sel.value=$('recordingSelect').value;sel.onchange=()=>{if(busy)return;pauseCameras();$('recordingSelect').value=sel.value;$('loadLocal').click()};$('datasetName').parentElement.append(sel);
}
let cameraVideos=[],cameraOffsets=[],cameraRAF=0;
function pauseCameras(){cancelAnimationFrame(cameraRAF);cameraRAF=0;cameraVideos.forEach(v=>v.pause());$('cameraPlay').textContent='▶ 播放'}
function alignedFrame(t){return frameAt(dataset.timeline?.times||[],t,start,end)}
function cameraPosition(t){return alignedFrame(t).time}
function seekCameras(t){t=cameraPosition(t);cameraVideos.forEach((v,i)=>{v.currentTime=mediaTime(t,dataset.min,cameraOffsets[i])});updateCameraTime(t)}
function updateCameraTime(t){const frame=alignedFrame(t);t=frame.time;$('cameraSeek').value=t;$('cameraTime').textContent=t.toFixed(3)+' s';
 const times=dataset.timeline?.times||[];$('alignedFrame').textContent=times.length?`帧 ${frame.index+1} / ${times.length}`:'统一播放时间';
 const ns=dataset.timeline?.source_timestamps_ns?.[frame.index];$('sourceTimestamp').textContent=ns?'源时间 '+ns+' ns':'';
 document.querySelectorAll('.camera-timestamp').forEach(el=>el.textContent=t.toFixed(3)+' s');cursor=t;renderCursor()}

function cameraTick(){const master=cameraVideos[0];if(!master||master.paused)return;const t=master.currentTime-cameraOffsets[0]+dataset.min;
 if(t>=end||master.ended){pauseCameras();seekCameras(end);return}
 cameraVideos.slice(1).forEach((v,j)=>{const target=mediaTime(t,dataset.min,cameraOffsets[j+1]);if(Math.abs(v.currentTime-target)>1/(2*(dataset.timeline?.fps||30)))v.currentTime=target});
 updateCameraTime(t);cameraRAF=requestAnimationFrame(cameraTick);
}
function setupCameras(d){pauseCameras();cameraVideos=[];cameraOffsets=[];const cameras=d.cameras||[];$('cameraPanel').hidden=!cameras.length;$('cameraGrid').replaceChildren();$('cameraError').textContent='';if(!cameras.length)return;
 for(const c of cameras){const card=document.createElement('article');card.className='camera-card';const label=document.createElement('div');label.textContent=c.name;const stamp=document.createElement('span');stamp.className='camera-timestamp';label.append(stamp);card.append(label);
 if(c.available&&c.url){const v=document.createElement('video');v.src=c.url;v.muted=true;v.playsInline=true;v.preload='auto';v.setAttribute('aria-label',c.name+' 相机');v.onloadedmetadata=()=>{v.currentTime=mediaTime(+$('cameraSeek').value,dataset.min,c.offset||0)};v.onerror=()=>{$('cameraError').textContent=c.name+' 视频加载失败，请确认共享目录连接与浏览器 H.264 支持。';pauseCameras()};card.append(v);cameraVideos.push(v);cameraOffsets.push(c.offset||0)}else{const msg=document.createElement('p');msg.textContent='此 episode 缺少视频文件';card.append(msg)}$('cameraGrid').append(card)}
 $('cameraPlay').disabled=!cameraVideos.length;$('cameraSeek').min=dataset.min;$('cameraSeek').max=dataset.max;$('cameraSeek').value=dataset.min;$('cameraEnd').textContent=dataset.max.toFixed(2)+' s';$('cameraTime').textContent=dataset.min.toFixed(2)+' s';
 $('cameraNote').textContent='相机、State / Action 与图表游标按同一帧定位；拖动关节图上的虚线或相机进度条同步调整时间。';updateCameraTime(dataset.min);
}
$('cameraPlay').onclick=async()=>{if(!cameraVideos.length)return;if(!cameraVideos[0].paused){const t=cameraVideos[0].currentTime-cameraOffsets[0]+dataset.min;pauseCameras();seekCameras(t);return}
 if(+$('cameraSeek').value>=end||+$('cameraSeek').value<start)seekCameras(start);
 try{cameraVideos.forEach(v=>v.playbackRate=+$('cameraSpeed').value);await Promise.all(cameraVideos.map(v=>v.play()));$('cameraPlay').textContent='Ⅱ 暂停';cameraTick()}catch(e){pauseCameras();$('cameraError').textContent='无法播放：'+e.message}};
$('cameraSeek').oninput=()=>{pauseCameras();seekCameras(+$('cameraSeek').value)};
$('cameraSpeed').onchange=()=>cameraVideos.forEach(v=>v.playbackRate=+$('cameraSpeed').value);
$('cameraFullscreen').onclick=()=>{$('cameraPanel').classList.toggle('camera-expanded');$('cameraFullscreen').textContent=$('cameraPanel').classList.contains('camera-expanded')?'收起画面':'展开画面'};
function scrubChart(svg,e){const r=svg.getBoundingClientRect();const t=start+Math.max(0,Math.min(1,((e.clientX-r.left)/r.width*540-48)/476))*(end-start);if(cameraVideos.length)seekCameras(t);else{cursor=t;renderCursor()}}
function finishScrub(svg,e){svg.dataset.scrubbing='false';svg.classList.remove('scrubbing');if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId)}
const savedSource=localStorage.getItem('jointscope.localSource');if(savedSource){try{const saved=JSON.parse(savedSource);$('localPath').value=saved.path;}catch{}}

setData(demo());

async function restoreLocalSource(){
 if(!savedSource)return;
 try{const saved=JSON.parse(savedSource);const health=await fetch('/api/health').then(r=>r.json());if(!health.capabilities?.includes('lerobot_local'))return;
 service=true;captureService=true;scannedPath=saved.path;$('localPath').value=saved.path;
 for(const [key,id] of [['state_column','stateColumn'],['action_column','actionColumn'],['unit','importUnit'],['state_topic','stateTopic'],['action_topic','actionTopic'],['state_field','stateField'],['action_field','actionField']])if(saved[key]!==undefined)$(id).value=saved[key];
 $('positional').checked=!!saved.positional;$('autoCapture').checked=saved.auto!==false;$('alignCapture').checked=!!saved.aligned;
 const scan=await localAPI('/api/local-inspect',{path:saved.path});localRecordings=scan.recordings;$('recordingSelect').innerHTML=localRecordings.map((d,i)=>`<option value="${i}">${esc(d.name)}</option>`).join('');$('recordingSelect').value=String(Math.min(saved.recording||0,localRecordings.length-1));$('localResults').hidden=false;
 $('loadLocal').click();
 }catch(e){toast('上次目录暂时无法读取，请重新导入：'+e.message)}
}
restoreLocalSource();
