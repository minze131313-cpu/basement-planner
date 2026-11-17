import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'bordy.basement.planner.v1';
const TAU = Math.PI * 2;
const ROOM = { w: 2.9, d: 4 };
const colors = { shelf: '#68816d', drying: '#a6b5ad', bikes: ['#487e83', '#ca916c', '#7b8eaa', '#9caa74'] };
const copy = value => JSON.parse(JSON.stringify(value));
const round = (n, digits=3) => +n.toFixed(digits);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const cm = n => Math.round(n * 100);
const deg = radians => ((radians * 180 / Math.PI) % 360 + 360) % 360;
const mobile = () => matchMedia('(max-width:760px)').matches;
let nextId = 10;
const defaults = () => ({
  version: 1,
  room: { height: 2.67, doorWidth: .8, doorOffset: .65, reserve: true },
  items: [
    { id:'shelf-1',type:'shelf',name:'储物架 01',w:1.2,d:.45,h:1.8,levels:5,x:.7,z:-1.72,angle:0,color:colors.shelf },
    { id:'drying-2',type:'drying',name:'X 型晾衣架',w:1.45,d:.6,h:1.25,x:-.67,z:-1.53,angle:0,color:colors.drying },
    ...[0,1,2,3].map((i)=>({id:`bike-${i+3}`,type:'bike',name:`公路车 0${i+1}`,w:1.7,d:.44,h:1,x:-.2+i*.47,z:.1,angle:Math.PI/2,color:colors.bikes[i]}))
  ]
});
function validated(raw) {
  if (!raw || raw.version!==1 || !Array.isArray(raw.items) || raw.items.length>60 || !raw.room) throw new Error('方案格式不正确');
  const numeric = (value,min,max) => { if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max) throw new Error('方案尺寸超出范围'); return value; };
  const used = new Set();
  if(Number(raw.room.doorOffset)+Number(raw.room.doorWidth)>ROOM.w)throw new Error('门的位置超出房间');
  return {version:1,room:{height:numeric(raw.room.height,2.2,4),doorWidth:numeric(raw.room.doorWidth,.6,1.4),doorOffset:numeric(raw.room.doorOffset,0,2.3),reserve:raw.room.reserve!==false},items:raw.items.map((item,i)=>{
    if(!['shelf','bike','drying'].includes(item.type)) throw new Error('未知陈设类型');
    const id=String(item.id||`item-${i}`).slice(0,50);if(used.has(id)) throw new Error('重复陈设');used.add(id);
    return {id,type:item.type,name:String(item.name||'陈设').slice(0,40),w:numeric(item.w,.2,3.5),d:numeric(item.d,.15,2),h:numeric(item.h,.2,3),...(item.type==='shelf'?{levels:clamp(Math.round(Number(item.levels)||5),2,10)}:{}),x:numeric(item.x,-5,5),z:numeric(item.z,-6,6),angle:numeric(item.angle,-TAU*100,TAU*100),color:/^#[0-9a-f]{6}$/i.test(item.color)?item.color:colors.shelf};
  })};
}
let state = defaults();
let loadedFromShare = false;
let storageAvailable = true;
function sharedPlanFromLocation() {
  const encoded=new URLSearchParams(location.hash.slice(1)).get('plan');if(!encoded)return null;
  if(encoded.length>65000)throw new Error('分享链接过长');
  const binary=atob(encoded.replace(/-/g,'+').replace(/_/g,'/'));
  return validated(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0)))));
}
try { const stored=localStorage.getItem(STORAGE_KEY); if(stored) state=validated(JSON.parse(stored)); } catch { /* A fresh example remains available. */ }
try {
  const shared=sharedPlanFromLocation();if(shared){state=shared;loadedFromShare=true;}
} catch { setTimeout(()=>toast('分享链接无法读取，已打开本机方案'),500); }
let selectedId=null, view='3d', showCeiling=false;
let history=[JSON.stringify(state)], historyIndex=0;
let renderer, scene, camera, controls, roomGroup, selectionGroup, fixedGroup, shadowLight;
let floorPlane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
const raycaster=new THREE.Raycaster(), pointer=new THREE.Vector2();
const objects=new Map(), walls=[];
let issues=new Map(), drag=null, libraryDrag=null, activeTouches=new Set(), downOnEmpty=null;
let lastSaved=JSON.stringify(state), toastTimer, saveTimer, suppressClickUntil=0;
const viewport=$('viewport');

function toast(message) { $('toast').textContent=message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3000); }
function persist() {
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); $('save-state').innerHTML='<i></i>本机已保存';storageAvailable=true; }
    catch { if(storageAvailable)toast('当前浏览器无法自动保存，请在「方案」中导出留存');storageAvailable=false;$('save-state').textContent='请导出留存'; }
  },200);
}
function commit() {
  const text=JSON.stringify(state);
  if(text!==history[historyIndex]) {history=history.slice(0,historyIndex+1);history.push(text);if(history.length>60)history.shift();historyIndex=history.length-1;}
  $('undo').disabled=historyIndex===0;$('redo').disabled=historyIndex>=history.length-1;
  lastSaved=text;persist();updateIssues();updateInventory();updateSelectionVisual();
  if(location.hash) historyReplaceWithoutHash();
}
function historyReplaceWithoutHash(){ try {window.history.replaceState(null,'',location.pathname+location.search);} catch{} }
function restoreHistory(delta) {
  if(historyIndex+delta<0||historyIndex+delta>=history.length)return;
  historyIndex+=delta;state=JSON.parse(history[historyIndex]);if(!state.items.some(i=>i.id===selectedId))selectedId=null;
  rebuildAll();persist();$('undo').disabled=historyIndex===0;$('redo').disabled=historyIndex>=history.length-1;toast(delta<0?'已撤销':'已重做');
}
const selected = () => state.items.find(i=>i.id===selectedId);
const mat = (color,roughness=.7,metalness=0) => new THREE.MeshStandardMaterial({color,roughness,metalness});
const shared = {post:mat('#637866',.55,.35),board:mat('#8b9c78',.82,.08),metal:mat('#bcc5bd',.3,.75),black:mat('#283830',.8,.1),rim:mat('#c1c7c0',.35,.65),wall:mat('#f1f1e7',.95),floor:mat('#dce2d2',.92),base:mat('#bac8ad',.85),duct:mat('#55665f',.65,.25)};
function box(group,w,h,d,x,y,z,material) {
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);return mesh;
}
function tube(group,a,b,r,material,segments=8) {
  const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),dir=end.clone().sub(start);
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,dir.length(),segments),material);mesh.position.copy(start).add(end).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir.normalize());mesh.castShadow=true;group.add(mesh);return mesh;
}
function line(group,points,color='#b0bfa6',dashed=false) {
  const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p)));
  const material=dashed?new THREE.LineDashedMaterial({color,dashSize:.06,gapSize:.04}):new THREE.LineBasicMaterial({color});
  const mesh=new THREE.Line(geometry,material);if(dashed)mesh.computeLineDistances();group.add(mesh);return mesh;
}
function label(group,text,x,y,z,size=.17,color='#6d8265') {
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=100;const ctx=canvas.getContext('2d');
  ctx.font='500 40px -apple-system, PingFang SC, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=color;ctx.fillText(text,256,50);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,transparent:true}));sprite.position.set(x,y,z);sprite.scale.set(size*5.12,size,1);sprite.renderOrder=5;group.add(sprite);return sprite;
}
function disposeGroup(group) {
  group.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material&&!Object.values(shared).includes(o.material)){if(o.material.map)o.material.map.dispose();o.material.dispose();}});
  group.removeFromParent();
}
function footprint(item) {
  const c=Math.cos(item.angle),s=Math.sin(item.angle);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b])=>({x:item.x+a*item.w/2*c+b*item.d/2*s,z:item.z-a*item.w/2*s+b*item.d/2*c}));
}
function polygonsOverlap(a,b,margin=.008) {
  for(const polygon of [a,b]) for(let i=0;i<polygon.length;i++) {
    const p=polygon[i],q=polygon[(i+1)%polygon.length];const axis={x:-(q.z-p.z),z:q.x-p.x};const length=Math.hypot(axis.x,axis.z);axis.x/=length;axis.z/=length;
    const av=a.map(p=>p.x*axis.x+p.z*axis.z),bv=b.map(p=>p.x*axis.x+p.z*axis.z);
    if(Math.max(...av)<=Math.min(...bv)+margin||Math.max(...bv)<=Math.min(...av)+margin)return false;
  }return true;
}
function rect(x1,z1,x2,z2){return[{x:x1,z:z1},{x:x2,z:z1},{x:x2,z:z2},{x:x1,z:z2}];}
function clampPosition(item) {
  const c=Math.abs(Math.cos(item.angle)),s=Math.abs(Math.sin(item.angle));const halfX=(item.w*c+item.d*s)/2,halfZ=(item.w*s+item.d*c)/2;
  if(halfX<=ROOM.w/2)item.x=round(clamp(item.x,-ROOM.w/2+halfX,ROOM.w/2-halfX));else item.x=0;
  if(halfZ<=ROOM.d/2)item.z=round(clamp(item.z,-ROOM.d/2+halfZ,ROOM.d/2-halfZ));else item.z=0;
}
function updateIssues() {
  issues=new Map(state.items.map(i=>[i.id,[]]));const polys=new Map(state.items.map(i=>[i.id,footprint(i)]));
  const add=(id,msg)=>issues.get(id).push(msg);
  const doorLeft=-ROOM.w/2+state.room.doorOffset;
  for(const item of state.items) {
    const poly=polys.get(item.id);
    if(poly.some(p=>Math.abs(p.x)>ROOM.w/2+.005||Math.abs(p.z)>ROOM.d/2+.005))add(item.id,'外廓超出房间，请缩小或转向');
    if(item.h>state.room.height+.005)add(item.id,'高于当前设定的室内净高');
    if(state.room.reserve&&polygonsOverlap(poly,rect(doorLeft,1.1,doorLeft+state.room.doorWidth,2)))add(item.id,'占用了门口规划预留区');
    if(item.h>2.55&&polygonsOverlap(poly,rect(-1.45,-1.44,1.45,-.77)))add(item.id,'高度可能碰到顶部风管，请核实');
    if(item.h>1&&polygonsOverlap(poly,rect(.70,1.87,.98,2)))add(item.id,'外廓与配电箱示意位置相交');
  }
  for(let i=0;i<state.items.length;i++)for(let j=i+1;j<state.items.length;j++)if(polygonsOverlap(polys.get(state.items[i].id),polys.get(state.items[j].id))) {
    add(state.items[i].id,`与${state.items[j].name}的外廓重叠`);add(state.items[j].id,`与${state.items[i].name}的外廓重叠`);
  }
  const count=[...issues.values()].filter(a=>a.length).length;
  const message=$('scene-message');message.classList.toggle('warning',count>0);message.querySelector('span:last-child').textContent=count?`${count} 件陈设需检查 · 点选查看`:'外廓无重叠 · 可继续试摆';
  const warning=selectedId?issues.get(selectedId)||[]:[];$('item-warning').hidden=!warning.length;$('item-warning').textContent=warning.join('；');
}
function makeShelf(item) {
  const g=new THREE.Group();const {w,d,h,levels}=item;
  const material=mat(item.color,.65,.28);const board=mat('#a4af8b',.87,.04);
  for(const x of [-w/2+.025,w/2-.025])for(const z of [-d/2+.025,d/2-.025]) {
    box(g,.035,h,.035,x,h/2,z,material);box(g,.06,.025,.06,x,.0125,z,shared.black);
    for(let k=1;k<=6;k++)box(g,.008,.014,.003,x,h*k/7,z+d/2*(z<0?-1:1)*.01,shared.black);
  }
  for(let i=0;i<levels;i++) {
    const y=.10+(h-.17)*i/(levels-1);box(g,w-.045,.026,d-.045,0,y,0,board);
    box(g,w,.045,.018,0,y-.018,-d/2+.018,material);box(g,w,.045,.018,0,y-.018,d/2-.018,material);
    for(const x of [-w/2+.018,w/2-.018])box(g,.018,.045,d-.04,x,y-.018,0,material);
  }
  tube(g,[-w/2+.025,.1,-d/2+.023],[w/2-.025,h-.1,-d/2+.023],.008,material);
  tube(g,[w/2-.025,.1,-d/2+.023],[-w/2+.025,h-.1,-d/2+.023],.008,material);
  return g;
}
function makeDrying(item) {
  const g=new THREE.Group();const {w,d,h}=item;const metal=shared.metal;
  for(const x of [-w*.36,w*.36]) {
    tube(g,[x,.035,-d*.47],[x,h,d*.42],.014,metal);tube(g,[x,.035,d*.47],[x,h,-d*.42],.014,metal);
    for(const z of [-d*.47,d*.47])box(g,.065,.035,.075,x,.018,z,shared.black);
    const cap=new THREE.Mesh(new THREE.SphereGeometry(.024,10,8),shared.black);cap.position.set(x,h*.50,0);g.add(cap);
  }
  for(const z of [-d*.42,d*.42])tube(g,[-w/2,h,z],[w/2,h,z],.016,metal);
  for(const x of [-w/2,w/2])tube(g,[x,h,-d*.42],[x,h,d*.42],.013,metal);
  for(let k=1;k<9;k++){const x=-w/2+w*k/9;tube(g,[x,h,-d*.42],[x,h,d*.42],.0065,metal);}
  tube(g,[-w*.36,h*.12,0],[w*.36,h*.12,0],.01,metal);
  return g;
}
function makeBike(item) {
  const g=new THREE.Group(), body=mat(item.color,.35,.4), dark=shared.black, metal=shared.rim;
  const wheelRadius=.325;
  for(const x of [-.49,.49]) {
    const tire=new THREE.Mesh(new THREE.TorusGeometry(wheelRadius-.013,.017,8,40),dark);tire.position.set(x,.342,0);tire.castShadow=true;g.add(tire);
    const rim=new THREE.Mesh(new THREE.TorusGeometry(.303,.009,6,40),metal);rim.position.set(x,.342,0);g.add(rim);
    const spokes=[];for(let k=0;k<16;k++){const a=k/16*TAU;spokes.push(x,.342,0,x+Math.cos(a)*.3,.342+Math.sin(a)*.3,0);}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(spokes,3));g.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:'#98a49c',transparent:true,opacity:.7})));
    tube(g,[x,.342,-.035],[x,.342,.035],.021,metal);
  }
  const rear=[-.49,.342,0],crank=[-.16,.285,0],seat=[-.29,.72,0],headTop=[.29,.73,0],headLow=[.35,.54,0],front=[.49,.342,0];
  for(const [a,b] of [[rear,crank],[rear,seat],[crank,seat],[seat,headTop],[crank,headLow],[headLow,headTop]])tube(g,a,b,.016,body,10);
  for(const z of [-.034,.034]){tube(g,[headLow[0],headLow[1],z],[front[0],front[1],z],.013,body);tube(g,[rear[0],rear[1],z],[crank[0],crank[1],z],.009,body);}
  tube(g,seat,[-.32,.84,0],.011,metal);box(g,.22,.032,.095,-.34,.856,0,dark);
  tube(g,headTop,[.265,.865,0],.013,metal);tube(g,[.265,.865,0],[.36,.87,0],.015,dark);
  tube(g,[.36,.87,-.18],[.36,.87,.18],.014,dark);
  for(const z of [-.18,.18]) {
    const points=[[.36,.87,z],[.435,.84,z],[.455,.77,z],[.42,.71,z],[.355,.72,z]];
    const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));const bar=new THREE.Mesh(new THREE.TubeGeometry(curve,16,.014,6,false),dark);bar.castShadow=true;g.add(bar);
  }
  const gear=new THREE.Mesh(new THREE.TorusGeometry(.07,.007,5,24),dark);gear.position.set(-.16,.285,.035);g.add(gear);
  tube(g,[-.16,.285,0],[-.1,.2,.075],.008,metal);tube(g,[-.16,.285,0],[-.22,.37,-.075],.008,metal);
  box(g,.06,.02,.09,-.1,.2,.1,dark);box(g,.06,.02,.09,-.22,.37,-.1,dark);
  line(g,[[-.49,.342,.035],[-.16,.36,.035],[-.09,.285,.035],[-.49,.342,.035]],'#69766c');
  g.scale.set(item.w/1.67,item.h/.9,item.d/.39);
  return g;
}
function addObject(item) {
  const group=new THREE.Group();group.userData.itemId=item.id;
  const model=item.type==='shelf'?makeShelf(item):item.type==='drying'?makeDrying(item):makeBike(item);group.add(model);
  const pick=new THREE.Mesh(new THREE.BoxGeometry(item.w,Math.max(item.h,.4),item.d),new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false,colorWrite:false}));
  pick.position.y=Math.max(item.h,.4)/2;pick.userData.itemId=item.id;group.add(pick);group.userData.pick=pick;
  group.position.set(item.x,0,item.z);group.rotation.y=item.angle;scene.add(group);objects.set(item.id,group);
}
function rebuildItem(item) {const old=objects.get(item.id);if(old)disposeGroup(old);objects.delete(item.id);addObject(item);updateSelectionVisual();renderSoon();}
function setObjectTransform(item){const group=objects.get(item.id);if(group){group.position.set(item.x,0,item.z);group.rotation.y=item.angle;}updateSelectionVisual();renderSoon();}
function makeRoom() {
  if(roomGroup)disposeGroup(roomGroup);if(fixedGroup)disposeGroup(fixedGroup);walls.length=0;
  roomGroup=new THREE.Group();scene.add(roomGroup);fixedGroup=new THREE.Group();scene.add(fixedGroup);fixedGroup.visible=showCeiling;
  const {height,doorWidth,doorOffset,reserve}=state.room;
  const left=-ROOM.w/2,right=ROOM.w/2,back=-ROOM.d/2,front=ROOM.d/2;
  box(roomGroup,ROOM.w+.2,.16,ROOM.d+.2,0,-.09,0,shared.base);box(roomGroup,ROOM.w,.022,ROOM.d,0,-.001,0,shared.floor);
  const gridPoints=[];
  for(let i=-14;i<=14;i++){const x=i/10;gridPoints.push(x,.014,back,x,.014,front);}
  for(let i=-19;i<=19;i++){const z=i/10;gridPoints.push(left,.014,z,right,.014,z);}
  const gridGeo=new THREE.BufferGeometry();gridGeo.setAttribute('position',new THREE.Float32BufferAttribute(gridPoints,3));roomGroup.add(new THREE.LineSegments(gridGeo,new THREE.LineBasicMaterial({color:'#acbd9d',transparent:true,opacity:.22})));
  function wall(w,d,x,z,side) {
    box(roomGroup,w,.08,d,x,.04,z,shared.wall);const mesh=box(roomGroup,w,height,d,x,height/2,z,shared.wall);mesh.userData.side=side;walls.push(mesh);
    return mesh;
  }
  wall(ROOM.w+.14,.07,0,back-.035,'back');wall(.07,ROOM.d,left-.035,0,'left');wall(.07,ROOM.d,right+.035,0,'right');
  const doorL=left+doorOffset,doorR=doorL+doorWidth;
  if(doorOffset>0)wall(doorOffset,.07,left+doorOffset/2,front+.035,'front');
  if(right>doorR)wall(right-doorR,.07,(doorR+right)/2,front+.035,'front');
  const lintel=box(roomGroup,doorWidth,Math.max(.1,height-2.05),.07,(doorL+doorR)/2,2.05+(height-2.05)/2,front+.035,shared.wall);lintel.userData.side='front';walls.push(lintel);
  line(roomGroup,[[doorL,.02,front],[doorR,.02,front]],'#7e9c6a',true);
  if(reserve) {
    const reserveMat=new THREE.MeshBasicMaterial({color:'#d8bf77',transparent:true,opacity:.19,side:THREE.DoubleSide,depthWrite:false});const area=new THREE.Mesh(new THREE.PlaneGeometry(doorWidth,.9),reserveMat);area.rotation.x=-Math.PI/2;area.position.set((doorL+doorR)/2,.018,1.55);roomGroup.add(area);
    line(roomGroup,[[doorL,.023,front],[doorL,.023,1.1],[doorR,.023,1.1],[doorR,.023,front]],'#b4a274',true);
  }
  label(roomGroup,'入 口',(doorL+doorR)/2,.02,front+.30,.15,'#647d53');
  line(roomGroup,[[left,.01,front+.46],[right,.01,front+.46]],'#8ea17c');for(const x of [left,right])line(roomGroup,[[x-.035,.01,front+.42],[x+.035,.01,front+.50]],'#8ea17c');
  label(roomGroup,'2.90 m',0,.03,front+.61,.16);
  line(roomGroup,[[left-.4,.01,back],[left-.4,.01,front]],'#8ea17c');for(const z of [back,front])line(roomGroup,[[left-.44,.01,z-.03],[left-.36,.01,z+.03]],'#8ea17c');
  label(roomGroup,'4.00 m',left-.60,.03,0,.16);
  // Fixed devices are illustrative volumes based on the accepted plan.
  const elec=box(roomGroup,.28,.39,.12,.84,1.195,front-.06,mat('#8e9b8e',.75,.2));elec.userData.device=true;
  box(roomGroup,.23,.025,.008,.84,1.27,front-.125,mat('#80927a'));
  for(let i=0;i<3;i++)box(roomGroup,.025,.025,.015,.78+i*.06,1.30,front-.13,mat(i===1?'#d3ad4e':'#8c985f'));
  const fan=box(roomGroup,.08,.28,.28,left+.04,2.20,-1.50,mat('#768575',.6,.15));fan.userData.device=true;
  for(let i=0;i<5;i++)box(roomGroup,.005,.012,.23,left+.086,2.11+i*.045,-1.50,shared.black);
  const foam=mat('#b9c4ad',.97);box(fixedGroup,ROOM.w,.35,.045,0,2.32+.175,back+.025,foam);
  const ductPoints=[[-1.45,2.61,-.97],[-.28,2.61,-.97],[.25,2.61,-1.24],[1.45,2.61,-1.24]];
  for(let i=0;i<ductPoints.length-1;i++) {
    const a=new THREE.Vector3(...ductPoints[i]),b=new THREE.Vector3(...ductPoints[i+1]);const length=a.distanceTo(b);
    const duct=box(fixedGroup,length+.08,.12,.36,0,0,0,shared.duct);duct.position.copy(a).add(b).multiplyScalar(.5);duct.rotation.y=-Math.atan2(b.z-a.z,b.x-a.x);
  }
  const light=box(fixedGroup,1.35,.028,.05,.05,2.60,-1.69,new THREE.MeshBasicMaterial({color:'#fffce8'}));light.castShadow=false;
  updateWallVisibility();renderSoon();
}
function updateWallVisibility(){if(!camera)return;for(const wall of walls){const side=wall.userData.side;wall.visible=view!=='top'&&(side==='back'?camera.position.z>0:side==='front'?camera.position.z<0:side==='left'?camera.position.x>0:camera.position.x<0);}}
function rebuildAll() {
  for(const group of objects.values())disposeGroup(group);objects.clear();makeRoom();for(const item of state.items)addObject(item);updateIssues();updateInventory();syncEditor();updateSelectionVisual();renderSoon();
}
function updateSelectionVisual() {
  if(!scene)return;if(selectionGroup)disposeGroup(selectionGroup);selectionGroup=new THREE.Group();scene.add(selectionGroup);
  const item=selected();if(!item)return;
  const warning=(issues.get(item.id)||[]).length>0;const color=warning?'#c29555':'#4a8d78';
  const fp=footprint(item);const points=fp.map(p=>[p.x,.032,p.z]);points.push(points[0]);line(selectionGroup,points,color);
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(item.w,item.d),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.10,side:THREE.DoubleSide,depthWrite:false}));plane.rotation.set(-Math.PI/2,item.angle,0,'YXZ');plane.position.set(item.x,.029,item.z);selectionGroup.add(plane);
  for(const p of fp){const circle=new THREE.Mesh(new THREE.CircleGeometry(.028,12),new THREE.MeshBasicMaterial({color,depthTest:false}));circle.rotation.x=-Math.PI/2;circle.position.set(p.x,.038,p.z);circle.renderOrder=4;selectionGroup.add(circle);}
  const group=objects.get(item.id);
  if(group){const geometry=new THREE.EdgesGeometry(new THREE.BoxGeometry(item.w,item.h,item.d));const outline=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.4}));outline.position.set(item.x,item.h/2,item.z);outline.rotation.y=item.angle;selectionGroup.add(outline);}
}
function selectItem(id,open=false) {
  selectedId=id;syncEditor();updateIssues();updateInventory();updateSelectionVisual();renderSoon();if(open&&mobile())$('inspector').classList.add('open');
}
function syncEditor() {
  const item=selected();$('inspector').classList.toggle('has-selection',!!item);$('item-editor').hidden=!item;$('empty-selection').hidden=!!item;
  if(!item){$('selection-name').textContent='选择一件陈设';$('selection-summary').textContent='在房间里轻点，即可调整';$('inspector').classList.remove('open');return;}
  $('selection-name').textContent=item.name;$('selection-summary').textContent=`${cm(item.w)} × ${cm(item.d)} × ${cm(item.h)} cm${item.type==='shelf'?` · ${item.levels} 层`:item.type==='bike'?' · 48 码车架':''}`;
  $('item-w').value=cm(item.w);$('item-d').value=cm(item.d);$('item-h').value=cm(item.h);$('item-levels').value=item.levels||5;
  $('shelf-levels').hidden=item.type!=='shelf';$('width-label').textContent='长度';$('depth-label').textContent=item.type==='shelf'?'深度':'宽度';
  $('item-angle').value=Math.round(deg(item.angle)/5)*5;$('angle-value').textContent=`${Math.round(deg(item.angle))}°`;
  $('item-x').value=cm(item.x+ROOM.w/2);$('item-z').value=cm(ROOM.d/2-item.z);
  $('item-note').textContent=item.type==='bike'?'48 码为车架尺码；整车外廓请按实车尺寸调整。':item.type==='drying'?'X 型折叠晾衣架，尺寸按展开后的外廓计算。':'层板按当前高度均匀分布；尺寸为储物架外廓。';
}
function updateInventory() {
  $('item-count').textContent=`${state.items.length} 件`;$('inventory').replaceChildren();
  for(const item of state.items) {
    const button=document.createElement('button');button.className='inventory-item'+(item.id===selectedId?' selected':'');button.dataset.id=item.id;
    const swatch=document.createElement('span');swatch.className=`inventory-swatch ${item.type}`;swatch.textContent=item.type==='bike'?'◉':item.type==='shelf'?'▤':'╳';swatch.style.color=item.color;
    const text=document.createElement('span');text.className='inventory-item-text';const title=document.createElement('b');title.textContent=item.name;const detail=document.createElement('small');detail.textContent=`${cm(item.w)} × ${cm(item.d)} × ${cm(item.h)} cm${item.type==='shelf'?` · ${item.levels}层`:''}`;text.append(title,detail);button.append(swatch,text);
    if((issues.get(item.id)||[]).length){const alert=document.createElement('span');alert.className='item-alert';alert.textContent='!';button.append(alert);}
    button.addEventListener('click',()=>selectItem(item.id,mobile()));$('inventory').append(button);
  }
}
function applyItemChange(changes,commitNow=true) {
  const item=selected();if(!item)return;Object.assign(item,changes);clampPosition(item);rebuildItem(item);updateIssues();syncEditor();updateInventory();if(commitNow)commit();
}
function nextName(type) {
  if(type==='drying')return state.items.some(i=>i.type==='drying')?`X 型晾衣架 ${state.items.filter(i=>i.type===type).length+1}`:'X 型晾衣架';
  const prefix=type==='shelf'?'储物架':'公路车';const names=new Set(state.items.map(i=>i.name));let i=1;while(names.has(`${prefix} ${String(i).padStart(2,'0')}`))i++;return `${prefix} ${String(i).padStart(2,'0')}`;
}
function newItem(type) {
  const item={id:`${type}-${Date.now().toString(36)}-${nextId++}`,type,name:nextName(type),x:0,z:.3,angle:0};
  if(type==='shelf')Object.assign(item,{w:1.2,d:.45,h:1.8,levels:5,color:colors.shelf});
  else if(type==='drying')Object.assign(item,{w:1.45,d:.6,h:1.25,color:colors.drying});
  else Object.assign(item,{w:1.7,d:.44,h:1,angle:Math.PI/2,color:colors.bikes[state.items.filter(i=>i.type==='bike').length%4]});
  return item;
}
function findPlacement(item) {
  const doorL=-ROOM.w/2+state.room.doorOffset;const occupied=state.items.map(footprint);let best=null;
  for(let z=-1.7;z<=1.7;z+=.15)for(let x=-1.25;x<=1.25;x+=.15) {
    const trial={...item,x,z};const poly=footprint(trial);if(poly.some(p=>Math.abs(p.x)>1.451||Math.abs(p.z)>2.001))continue;
    const count=occupied.filter(p=>polygonsOverlap(poly,p)).length+(state.room.reserve&&polygonsOverlap(poly,rect(doorL,1.1,doorL+state.room.doorWidth,2))?2:0);
    const score=count*1000+Math.hypot(x,z-.4);if(!best||score<best.score)best={x,z,score};
  }
  if(best){item.x=round(best.x);item.z=round(best.z);}clampPosition(item);
}
function addItem(type) {if(state.items.length>=60){toast('最多可放置 60 件陈设');return;}const item=newItem(type);findPlacement(item);state.items.push(item);addObject(item);selectItem(item.id);commit();toast(`已添加${type==='bike'?'公路车':type==='shelf'?'储物架':'晾衣架'}，按住即可拖动`);}
function duplicateItem() {const item=selected();if(!item)return;if(state.items.length>=60){toast('最多可放置 60 件陈设');return;}const next={...copy(item),id:`${item.type}-${Date.now().toString(36)}-${nextId++}`,name:nextName(item.type)};findPlacement(next);state.items.push(next);addObject(next);selectItem(next.id);commit();toast('已复制陈设');}
function deleteItem() {const item=selected();if(!item)return;state.items=state.items.filter(i=>i.id!==item.id);disposeGroup(objects.get(item.id));objects.delete(item.id);selectedId=null;syncEditor();commit();renderSoon();toast('已删除，可点撤销恢复');}

let frameRequested=false, framesLeft=0;
function renderSoon(){if(!renderer)return;framesLeft=12;if(!frameRequested){frameRequested=true;requestAnimationFrame(tick);}}
function tick() {frameRequested=false;if(!renderer)return;controls.update();updateWallVisibility();renderer.render(scene,camera);if(--framesLeft>0){frameRequested=true;requestAnimationFrame(tick);}}
function resize() {
  if(!renderer)return;const {width,height}=viewport.getBoundingClientRect();renderer.setSize(width,height,false);const aspect=width/Math.max(height,1);
  let span=view==='top'?5.25:(mobile()?6.55:6.15);
  if(aspect<.85)span=Math.max(span,(view==='3d'?5.55:4.6)/aspect);
  camera.left=-span*aspect/2;camera.right=span*aspect/2;camera.top=span/2;camera.bottom=-span/2;
  camera.updateProjectionMatrix();renderSoon();
}
function setView(value) {
  view=value;camera.zoom=1;controls.target.set(0,view==='top'?0:.7,0);
  if(shadowLight)shadowLight.castShadow=value!=='top';
  if(value==='top'){camera.position.set(0,9,.001);controls.enableRotate=false;controls.minPolarAngle=0;controls.maxPolarAngle=.001;}
  else{camera.position.set(5.3,5.8,7.0);controls.enableRotate=true;controls.minPolarAngle=.1;controls.maxPolarAngle=Math.PI/2-.04;}
  controls.update();$('view-3d').classList.toggle('active',value==='3d');$('view-top').classList.toggle('active',value==='top');$('view-3d').setAttribute('aria-pressed',value==='3d');$('view-top').setAttribute('aria-pressed',value==='top');
  $('gesture-hint').textContent=value==='top'?'拖动物件摆放 · 空白处平移 · 双指缩放':'拖动陈设摆放 · 空白处转动视角 · 双指缩放';resize();
}
function pointerRay(clientX,clientY){const r=viewport.getBoundingClientRect();pointer.set((clientX-r.left)/r.width*2-1,-(clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);return raycaster;}
function floorPoint(clientX,clientY){const point=new THREE.Vector3();return pointerRay(clientX,clientY).ray.intersectPlane(floorPlane,point)?point:null;}
function hitItem(clientX,clientY) {const picks=[...objects.values()].map(g=>g.userData.pick);return pointerRay(clientX,clientY).intersectObjects(picks,false)[0]?.object.userData.itemId||null;}
function eventInViewport(e){const r=viewport.getBoundingClientRect();return e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom;}
function setupPointerEvents() {
  const canvas=renderer.domElement;
  canvas.addEventListener('pointerdown',e=>{
    activeTouches.add(e.pointerId);
    if(activeTouches.size>1){
      const previous=drag;drag=null;controls.enabled=true;
      if(previous){if(previous.moved)commit();canvas.dispatchEvent(new PointerEvent('pointerdown',{pointerId:previous.pointerId,pointerType:previous.pointerType,clientX:previous.lastX,clientY:previous.lastY,button:0,buttons:1,bubbles:true,isPrimary:true}));}
      return;
    }
    if(e.button!==0)return;
    const id=hitItem(e.clientX,e.clientY),point=floorPoint(e.clientX,e.clientY);
    if(id&&point){selectItem(id);const item=selected();drag={id,pointerId:e.pointerId,pointerType:e.pointerType,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,dx:item.x-point.x,dz:item.z-point.z,moved:false};controls.enabled=false;canvas.setPointerCapture(e.pointerId);e.stopImmediatePropagation();e.preventDefault();}
    else downOnEmpty={x:e.clientX,y:e.clientY};
  },true);
  canvas.addEventListener('pointermove',e=>{
    if(drag&&drag.pointerId===e.pointerId){e.stopImmediatePropagation();drag.lastX=e.clientX;drag.lastY=e.clientY;const point=floorPoint(e.clientX,e.clientY),item=selected();if(!point||!item)return;
      if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4)drag.moved=true;if(!drag.moved)return;
      const step=$('snap').checked?.05:.001;item.x=round(Math.round((point.x+drag.dx)/step)*step);item.z=round(Math.round((point.z+drag.dz)/step)*step);clampPosition(item);setObjectTransform(item);updateIssues();syncEditor();
    }
  },true);
  const end=e=>{
    activeTouches.delete(e.pointerId);
    if(drag&&drag.pointerId===e.pointerId){if(drag.moved)commit();drag=null;controls.enabled=true;renderSoon();e.stopImmediatePropagation();}
    else if(downOnEmpty&&Math.hypot(e.clientX-downOnEmpty.x,e.clientY-downOnEmpty.y)<4)selectItem(null);
    downOnEmpty=null;
  };
  canvas.addEventListener('pointerup',end,true);canvas.addEventListener('pointercancel',end,true);
  for(const card of document.querySelectorAll('[data-add]')) {
    card.addEventListener('click',()=>{if(Date.now()>suppressClickUntil)addItem(card.dataset.add);});
    card.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;libraryDrag={type:card.dataset.add,startX:e.clientX,startY:e.clientY,pointerId:e.pointerId,item:null};card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove',e=>{
      if(!libraryDrag||libraryDrag.pointerId!==e.pointerId)return;
      if(!libraryDrag.item&&Math.hypot(e.clientX-libraryDrag.startX,e.clientY-libraryDrag.startY)>9&&state.items.length<60){
        libraryDrag.item=newItem(libraryDrag.type);state.items.push(libraryDrag.item);addObject(libraryDrag.item);controls.enabled=false;selectItem(libraryDrag.item.id);
      }
      if(libraryDrag.item){e.preventDefault();const point=floorPoint(e.clientX,e.clientY);if(point){const item=libraryDrag.item;const step=$('snap').checked?.05:.001;item.x=round(Math.round(point.x/step)*step);item.z=round(Math.round(point.z/step)*step);clampPosition(item);setObjectTransform(item);updateIssues();syncEditor();}}
    });
    const finish=e=>{
      if(!libraryDrag||libraryDrag.pointerId!==e.pointerId)return;
      const item=libraryDrag.item;
      const dropPoint=item?floorPoint(e.clientX,e.clientY):null;
      const validDrop=dropPoint&&Math.abs(dropPoint.x)<=ROOM.w/2&&Math.abs(dropPoint.z)<=ROOM.d/2&&document.elementFromPoint(e.clientX,e.clientY)===canvas;
      if(item){suppressClickUntil=Date.now()+500;if(validDrop&&e.type!=='pointercancel'){commit();toast('已放入房间');}else{state.items=state.items.filter(i=>i.id!==item.id);disposeGroup(objects.get(item.id));objects.delete(item.id);selectItem(null);updateIssues();updateInventory();}}
      libraryDrag=null;controls.enabled=true;renderSoon();
    };
    card.addEventListener('pointerup',finish);card.addEventListener('pointercancel',finish);
  }
  window.addEventListener('blur',()=>{if(drag?.moved)commit();drag=null;activeTouches.clear();controls.enabled=true;});
}
function wireUI() {
  $('view-3d').onclick=()=>setView('3d');$('view-top').onclick=()=>setView('top');$('view-reset').onclick=()=>setView(view);
  $('undo').onclick=()=>restoreHistory(-1);$('redo').onclick=()=>restoreHistory(1);
  $('show-ceiling').onchange=e=>{showCeiling=e.target.checked;fixedGroup.visible=showCeiling;renderSoon();};
  for(const [id,key,min,max] of [['item-w','w',20,350],['item-d','d',15,200],['item-h','h',20,300]])$(id).addEventListener('change',e=>{const value=Number(e.target.value);if(!Number.isFinite(value)||value<min||value>max){toast(`请输入 ${min}–${max} cm`);syncEditor();return;}applyItemChange({[key]:value/100});});
  $('item-levels').onchange=e=>{if(!selected())return;applyItemChange({levels:clamp(Math.round(Number(e.target.value)||5),2,10)});};
  $('level-minus').onclick=()=>{if(selected())applyItemChange({levels:clamp(selected().levels-1,2,10)});};$('level-plus').onclick=()=>{if(selected())applyItemChange({levels:clamp(selected().levels+1,2,10)});};
  $('rotate-left').onclick=()=>{if(selected())applyItemChange({angle:(deg(selected().angle)+270)%360*Math.PI/180});};$('rotate-right').onclick=()=>{if(selected())applyItemChange({angle:(deg(selected().angle)+90)%360*Math.PI/180});};
  $('item-angle').addEventListener('input',e=>{const item=selected();if(!item)return;item.angle=+e.target.value*Math.PI/180;clampPosition(item);setObjectTransform(item);$('angle-value').textContent=`${e.target.value}°`;updateIssues();});$('item-angle').addEventListener('change',()=>{syncEditor();commit();});
  $('item-x').onchange=e=>{const value=Number(e.target.value);if(Number.isFinite(value))applyItemChange({x:value/100-ROOM.w/2});else syncEditor();};
  $('item-z').onchange=e=>{const value=Number(e.target.value);if(Number.isFinite(value))applyItemChange({z:ROOM.d/2-value/100});else syncEditor();};
  $('duplicate').onclick=duplicateItem;$('delete').onclick=deleteItem;
  for(const id of ['sheet-toggle','sheet-edit'])$(id).onclick=()=>$('inspector').classList.toggle('open');$('sheet-close').onclick=()=>$('inspector').classList.remove('open');
  $('room-open').onclick=()=>{const r=state.room;$('room-height').value=cm(r.height);$('door-width').value=cm(r.doorWidth);$('door-offset').value=cm(r.doorOffset);$('door-reserve').checked=r.reserve;$('room-dialog').showModal();};
  $('room-apply').onclick=()=>{
    const height=Number($('room-height').value)/100,doorWidth=Number($('door-width').value)/100,doorOffset=Number($('door-offset').value)/100;
    if(!Number.isFinite(height)||height<2.2||height>4||!Number.isFinite(doorWidth)||doorWidth<.6||doorWidth>1.4||!Number.isFinite(doorOffset)||doorOffset<0||doorOffset+doorWidth>ROOM.w){toast('请检查净高、门宽和门到墙的距离');return;}
    state.room={height,doorWidth,doorOffset,reserve:$('door-reserve').checked};makeRoom();commit();$('room-dialog').close();toast('房间参数已更新');
  };
  $('help-open').onclick=()=>$('help-dialog').showModal();$('export-open').onclick=()=>$('export-dialog').showModal();
  $('share-plan').onclick=async()=>{
    const bytes=new TextEncoder().encode(JSON.stringify(state));let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
    const encoded=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');const url=`${location.origin}${location.pathname}#plan=${encoded}`;
    try {if(navigator.share&&mobile()){await navigator.share({title:'我的地下室摆放方案',url});}else{await navigator.clipboard.writeText(url);toast('方案链接已复制，另一部手机打开即可继续');}}catch(e){if(e.name!=='AbortError')toast('复制受限，请用导出方案文件保存');}
  };
  $('download-plan').onclick=()=>{downloadBlob(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),`地下室方案-${stamp()}.json`);toast('方案文件已导出');};
  $('import-plan').onclick=()=>$('import-file').click();
  $('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(file.size>100000){toast('文件过大，请选择导出的方案文件');e.target.value='';return;}try{const next=validated(JSON.parse(await file.text()));if(next.room.doorOffset+next.room.doorWidth>ROOM.w)throw new Error();askConfirm('导入这个摆放方案？','导入会替换当前布局，之后仍可撤销。',()=>{state=next;selectedId=null;rebuildAll();commit();$('export-dialog').close();toast('方案已导入');});}catch{toast('无法读取，请选择本工具导出的 JSON 方案文件');}e.target.value='';};
  $('save-image').onclick=()=>{renderer.render(scene,camera);const canvas=document.createElement('canvas');canvas.width=renderer.domElement.width;canvas.height=renderer.domElement.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#eff3e9';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(renderer.domElement,0,0);canvas.toBlob(blob=>{if(blob){downloadBlob(blob,`地下室视角-${stamp()}.png`);toast('当前视角图片已导出');}},'image/png');};
  $('reset-plan').onclick=()=>askConfirm('恢复初始示例摆放？','当前布局可先导出留存。恢复后仍可撤销。',()=>{state=defaults();selectedId=null;rebuildAll();commit();$('export-dialog').close();toast('已恢复初始摆放');});
  window.addEventListener('hashchange',()=>{
    try{const shared=sharedPlanFromLocation();if(!shared)return;state=shared;selectedId=null;document.querySelectorAll('dialog[open]').forEach(d=>d.close());rebuildAll();commit();toast('已载入分享方案，调整会保存在本机');}
    catch{toast('分享链接无法读取，当前布局已保留');}
  });
  document.addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea')||document.querySelector('dialog[open]'))return;
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();restoreHistory(e.shiftKey?1:-1);}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteItem();}
    if(e.key.toLowerCase()==='r'&&selected())applyItemChange({angle:selected().angle+Math.PI/2});
    const directions={ArrowLeft:[-.05,0],ArrowRight:[.05,0],ArrowUp:[0,-.05],ArrowDown:[0,.05]};if(directions[e.key]&&selected()){e.preventDefault();const [dx,dz]=directions[e.key],i=selected();applyItemChange({x:i.x+dx,z:i.z+dz});}
  });
}
function stamp(){const now=new Date();return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
let confirmCallback=null;
function askConfirm(title,body,callback){$('confirm-title').textContent=title;$('confirm-copy').textContent=body;confirmCallback=callback;$('confirm-dialog').showModal();}
$('confirm-cancel').onclick=()=>$('confirm-dialog').close();$('confirm-ok').onclick=()=>{$('confirm-dialog').close();if(confirmCallback)confirmCallback();confirmCallback=null;};

function init() {
  scene=new THREE.Scene();
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.35;
  viewport.append(renderer.domElement);renderer.domElement.setAttribute('aria-label','地下室3D规划场景');
  camera=new THREE.OrthographicCamera(-4,4,4,-4,.01,60);controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.16;controls.enablePan=true;controls.minZoom=.55;controls.maxZoom=2.8;controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.DOLLY,RIGHT:THREE.MOUSE.PAN};controls.touches={ONE:THREE.TOUCH.ROTATE,TWO:THREE.TOUCH.DOLLY_PAN};
  controls.addEventListener('change',()=>{if(!frameRequested)renderSoon();});controls.addEventListener('start',()=>{framesLeft=16;});
  scene.add(new THREE.HemisphereLight('#fcfff1','#9cae93',2.4));
  const sun=new THREE.DirectionalLight('#fff8e1',3.5);shadowLight=sun;sun.position.set(2,7,4);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-4;sun.shadow.camera.right=4;sun.shadow.camera.top=4;sun.shadow.camera.bottom=-4;sun.shadow.normalBias=.025;sun.shadow.bias=-.0002;scene.add(sun);
  const fill=new THREE.DirectionalLight('#eaf1e5',1);fill.position.set(-3,3,-2);scene.add(fill);
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({color:'#52623e',opacity:.11}));ground.rotation.x=-Math.PI/2;ground.position.y=-.18;ground.receiveShadow=true;scene.add(ground);
  wireUI();setView('3d');rebuildAll();setupPointerEvents();$('undo').disabled=true;$('redo').disabled=true;
  controls.touches.ONE=THREE.TOUCH.ROTATE;
  const originalSetView=setView;
  $('view-top').onclick=()=>{originalSetView('top');controls.mouseButtons.LEFT=THREE.MOUSE.PAN;controls.touches.ONE=THREE.TOUCH.PAN;};
  $('view-3d').onclick=()=>{originalSetView('3d');controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;controls.touches.ONE=THREE.TOUCH.ROTATE;};
  new ResizeObserver(resize).observe(viewport);$('loading').hidden=true;persist();
  if(loadedFromShare)setTimeout(()=>toast('已载入分享方案，调整会保存在本机'),800);
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();toast('画面暂时中断，请刷新重新打开；摆放已自动保存');});
  // This read-only bridge makes layout checks possible without changing user data.
  window.roomPlanner={getState:()=>copy(state),getIssues:()=>Object.fromEntries(issues),getSelected:()=>selectedId,getView:()=>view,getCameraZoom:()=>camera.zoom,ready:true,project:(id)=>{const item=state.items.find(i=>i.id===id);if(!item)return null;const p=new THREE.Vector3(item.x,item.h*.45,item.z).project(camera);const r=viewport.getBoundingClientRect();return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};},projectFloor:(x,z)=>{const p=new THREE.Vector3(x,0,z).project(camera);const r=viewport.getBoundingClientRect();return{x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};},getStats:()=>({calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries})};
}
try{init();}catch(error){console.error(error);$('loading').innerHTML='<span>3D 画面未能打开</span><span style="max-width:260px;text-align:center;line-height:1.8">请使用新版 Safari 或 Chrome，并确认浏览器允许 WebGL。刷新后本机方案会继续保留。</span>';}
