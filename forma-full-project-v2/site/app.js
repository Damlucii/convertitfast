/* Forma — independent frontend, no external runtime dependencies. */
'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sizeLabel = n => Number.isFinite(Number(n)) ? (n < 1024 ? n+' B' : n < 1048576 ? (n/1024).toFixed(1)+' KB' : n < 1073741824 ? (n/1048576).toFixed(2)+' MB' : (n/1073741824).toFixed(2)+' GB') : '—';
const timeLabel = n => !n ? '—' : n>=3600 ? new Date(n*1000).toISOString().substring(11,19) : `${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
const imageExt = new Set(['jpg','jpeg','png','webp','gif','bmp','tiff','tif','ico','avif','heic','heif','jxl','jp2','j2k','tga','psd','svg','dng','cr2','cr3','nef','arw','raf','orf','rw2','pef']);
const videoExt = new Set(['mp4','mov','mkv','webm','avi','wmv','flv','mpeg','mpg','m4v','3gp','ts','mts','m2ts','ogv','vob']);
const offlineImages = ['jpg','png','webp'];
const preferredImages = ['jpg','png','webp','avif','heic','tiff','gif','bmp','ico'];
const preferredVideos = ['mp4','mov','mkv','webm','avi','gif'];
const state = {
  active:'image', view:'workspace', items:[], selected:null,
  api:(localStorage.getItem('forma-api')||'').trim().replace(/\/$/,''),
  apiKey:localStorage.getItem('forma-api-key')||'',
  connected:false, capabilities:null,
  theme:localStorage.getItem('forma-theme') || 'dark',
  defaultQuality:localStorage.getItem('forma-quality') || 'maximum',
  history:JSON.parse(localStorage.getItem('forma-history') || '[]'),
  inflight:false,
};
document.documentElement.dataset.theme=state.theme;
let fileId=0;
function fileType(name, mime){let ext=(name.split('.').pop()||'').toLowerCase();return mime.startsWith('video/')||videoExt.has(ext)?'video':(mime.startsWith('image/')||imageExt.has(ext))?'image':null;}
function filenameExt(name){const x=(name.split('.').pop()||'').toLowerCase();return ({jpeg:'jpg',tif:'tiff'})[x]||x;}
function toast(message){const el=document.createElement('div');el.className='toast';el.innerHTML=icon('info')+`<span>${escapeHTML(message)}</span>`;$('#toast-area').append(el);setTimeout(()=>el.remove(),4200);}
function visibleItems(){return state.items.filter(j=>j.kind===state.active);}
function selectedItem(){return state.items.find(j=>j.id===state.selected) || visibleItems()[0];}
function setTheme(next){state.theme=next;localStorage.setItem('forma-theme',next);document.documentElement.dataset.theme=next;$('#nav-theme').querySelector('use').setAttribute('href', next==='dark'?'#i-moon':'#i-sun');}
function defaultTarget(j){if(j.kind==='video')return ({mov:'mp4',mp4:'webm',mkv:'mp4',webm:'mp4'})[j.format]||'mp4';return ({heic:'jpg',heif:'jpg',jpg:'png',png:'webp',webp:'png',avif:'png',gif:'webp'})[j.format]||'jpg';}
function availableOutputs(j){if(j.kind==='image')return state.connected && state.capabilities ? state.capabilities.imageOutputs : preferredImages;
  return state.connected && state.capabilities ? state.capabilities.videoOutputs : preferredVideos;}
function render(){const visible=visibleItems();const has=visible.length>0;
  $('#dropzone').hidden=has;$('#queue-area').hidden=!has;
  $('#files-counter').textContent=`${visible.length} file${visible.length===1?'':'s'} in queue`;
  $('#clear-all').hidden=!has;$('#queue-count').textContent=visible.length;
  $('#drop-formats').textContent=state.active==='image'?'JPEG · PNG · HEIC · WEBP · AVIF · TIFF + more':'MP4 · MOV · MKV · WEBM · AVI + more';
  $('#tab-image').classList.toggle('active',state.active==='image');$('#tab-video').classList.toggle('active',state.active==='video');
  $('#tab-image').setAttribute('aria-selected',state.active==='image');$('#tab-video').setAttribute('aria-selected',state.active==='video');
  $('#file-input').accept=state.active==='image'?'image/*,.heic,.heif,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.psd,.tiff,.avif': 'video/*,.mov,.mkv,.avi,.wmv,.flv,.ts,.m2ts,.vob';
  $('#engine-label').textContent=state.connected?'Server engine online':'Local engine';
  $('.pulse-dot').classList.toggle('online',state.connected);
  $('#queue-note').textContent=state.connected?'High-fidelity processing via your configured server.':'Basic browser conversion may remove EXIF and color profiles. Connect a server for maximum fidelity.';
  if(has){renderQueue();renderInspector();renderActionButtons();}
}
function renderQueue(){const list=$('#queue-list');list.innerHTML='';for(const j of visibleItems()){
  const div=document.createElement('div');div.className='queue-item'+(selectedItem()?.id===j.id?' selected':'');div.tabIndex=0;div.setAttribute('role','button');div.setAttribute('aria-label','Select '+j.name);
  const media=j.previewURL && j.kind==='image'?`<img class="item-thumbnail" src="${escapeHTML(j.previewURL)}" alt="">`:`<span class="item-thumbnail">${icon(j.kind==='image'?'image':'video')}</span>`;
  const status=({ready:'Ready',uploading:'Uploading',queued:'Queued',processing:'Converting',done:'Complete',error:'Failed'})[j.status];
  div.innerHTML=`${media}<div class="item-detail"><strong title="${escapeHTML(j.name)}">${escapeHTML(j.name)}</strong><small>${escapeHTML(j.format.toUpperCase())} <span aria-hidden="true">→</span> ${escapeHTML(j.target.toUpperCase())} &nbsp;·&nbsp; ${sizeLabel(j.file.size)}</small>${j.status==='processing'||j.status==='uploading'?`<div class="item-progress"><div style="width:${j.progress}%"></div></div>`:''}</div><span class="item-status ${j.status}">${status}${j.status==='processing'||j.status==='uploading'?' '+Math.round(j.progress)+'%':''}</span><button class="item-remove" aria-label="Remove ${escapeHTML(j.name)}">${icon('x')}</button>`;
  div.addEventListener('click',()=>{state.selected=j.id;render();});div.addEventListener('keydown',e=>{if(e.key==='Enter'){state.selected=j.id;render();}});
  div.querySelector('.item-remove').addEventListener('click',e=>{e.stopPropagation();removeItem(j.id);});list.appendChild(div);
}}
function renderInspector(){const j=selectedItem();if(!j)return;const outputs=availableOutputs(j);if(!outputs.includes(j.target))j.target=outputs[0];
  const options=outputs.map(x=>`<option value="${escapeHTML(x)}" ${x===j.target?'selected':''}>${x.toUpperCase()}</option>`).join('');
  const stats=[j.meta.width&&j.meta.height?`${j.meta.width} × ${j.meta.height}`:null,j.meta.duration?timeLabel(j.meta.duration):null,sizeLabel(j.file.size),j.meta.codec||null].filter(Boolean).join(' · ');
  const thumb=j.previewURL&&j.kind==='image'?`<img src="${escapeHTML(j.previewURL)}" alt="Preview">` : j.previewURL&&j.kind==='video'?`<video src="${escapeHTML(j.previewURL)}" muted preload="metadata"></video>` :icon(j.kind==='image'?'image':'video');
  const presets=[['maximum','Maximum','Prioritize detail'],['lossless','True lossless','Where supported'],['balanced','Balanced','Quality + size'],['small','Small file','Smaller output']].map(([v,title,sub])=>`<button class="preset ${j.quality===v?'chosen':''}" data-preset="${v}"><strong>${title}${j.quality===v?icon('check'):''}</strong><span>${sub}</span></button>`).join('');
  const ready=j.status!=='processing'&&j.status!=='uploading'&&j.status!=='queued';
  const help=j.kind==='video'&&!state.connected?'A conversion server is required to create a GIF or another video format. Open Settings to connect one.':
    j.kind==='image'&&!state.connected?'Browser-only mode supports JPG, PNG and WebP. Color profiles and EXIF may be lost.':'Resolution is preserved. Impossible or lossy conversions are never labeled lossless.';
  const codecs=j.kind==='video' ? ({mp4:['auto','h264','h265'],mov:['auto','h264','h265'],mkv:['auto','h264','h265','vp9','av1','ffv1'],webm:['auto','vp9','av1'],avi:['auto'],gif:['auto']}[j.target]||['auto']) : [];
  if(!codecs.includes(j.videoCodec))j.videoCodec='auto';
  const gifOptions=j.kind==='video' && j.target==='gif' ? `<div class="gif-panel"><strong>GIF export</strong><small>GIF supports only 256 colors and has no audio. For 4K videos, 960px / 12 FPS is a practical starting point; choosing Original may create a very large file.</small><div class="gif-controls"><label>Width<select id="gif-width"><option value="0" ${j.gifWidth===0?'selected':''}>Original resolution</option>${[1920,1280,960,720,480].map(w=>`<option value="${w}" ${j.gifWidth===w?'selected':''}>${w}px max</option>`).join('')}</select></label><label>FPS<select id="gif-fps">${[10,12,15,20,24,30].map(f=>`<option value="${f}" ${j.gifFPS===f?'selected':''}>${f} FPS</option>`).join('')}</select></label><label>Length<select id="gif-seconds"><option value="0" ${j.gifSeconds===0?'selected':''}>Entire video</option>${[5,10,15,30].map(d=>`<option value="${d}" ${j.gifSeconds===d?'selected':''}>First ${d}s</option>`).join('')}</select></label></div></div>`:'';
  const advanced=j.kind==='video' ? j.target==='gif' ? gifOptions : `<details class="advanced-panel"><summary>Advanced video settings ${icon('chevron')}</summary><div class="advanced-content"><label class="inspector-label" for="codec-select">VIDEO CODEC</label><div class="select-wrap"><select class="format-select" id="codec-select">${codecs.map(c=>`<option value="${c}" ${j.videoCodec===c?'selected':''}>${c==='auto'?'Automatic':c.toUpperCase()}</option>`).join('')}</select></div><div class="toggle-row"><div class="toggle-label">Include audio <small>Keep sound when compatible</small></div><button id="audio-toggle" class="switch ${j.includeAudio?'on':''}" role="switch" aria-checked="${j.includeAudio}" aria-label="Include audio"></button></div></div></details>` : '';
  $('#inspector').innerHTML=`<div class="inspector-eyebrow"><span>FILE INSPECTOR</span><span>${String(visibleItems().indexOf(j)+1).padStart(2,'0')} / ${String(visibleItems().length).padStart(2,'0')}</span></div>
  <div class="source-overview"><div class="source-preview">${thumb}</div><div><div class="source-name">${escapeHTML(j.name)}</div><div class="meta-row">${escapeHTML(stats)}</div></div></div>
  <div class="settings-group"><label class="inspector-label" for="output-format">OUTPUT FORMAT</label><div class="select-wrap"><select id="output-format" class="format-select">${options}</select></div></div>
  <div class="settings-group"><label class="inspector-label">QUALITY PROFILE</label><div class="preset-group">${presets}</div></div>
  <div class="toggle-row"><div class="toggle-label">Remove metadata <small>Strip EXIF and personal metadata</small></div><button class="switch ${j.removeMetadata?'on':''}" id="metadata-toggle" role="switch" aria-checked="${j.removeMetadata}" aria-label="Remove metadata"></button></div>
  ${advanced}
  <div class="inspector-help">${icon('info')}<span>${escapeHTML(help)}</span></div>
  ${j.error?`<div class="inspector-error">${escapeHTML(j.error)}</div>`:''}
  <div class="inspector-actions">${j.status==='done'?`<button class="button button-primary" id="file-download">${icon('download')} Download</button>${j.kind==='image'&&!!j.outputURL?`<button class="button button-secondary" id="file-compare">${icon('compare')}</button>`:''}`:`<button class="button button-primary" id="file-convert" ${ready?'':'disabled'}>${icon('bolt')} ${j.status==='error'?'Retry conversion':'Convert file'} ${icon('arrow')}</button>`}</div>`;
  $('#output-format').addEventListener('change',e=>{j.target=e.target.value;if(j.status==='done'){j.status='ready';j.outputURL=null;j.serverId=null;}render();});
  $$('#inspector .preset').forEach(el=>el.addEventListener('click',()=>{j.quality=el.dataset.preset;if(j.status==='done'){j.status='ready';j.outputURL=null;j.serverId=null;}render();}));
  $('#metadata-toggle').addEventListener('click',()=>{j.removeMetadata=!j.removeMetadata;if(j.status==='done'){j.status='ready';j.outputURL=null;j.serverId=null;}render();});
  if($('#gif-width'))$('#gif-width').addEventListener('change',e=>{j.gifWidth=Number(e.target.value);});
  if($('#gif-fps'))$('#gif-fps').addEventListener('change',e=>{j.gifFPS=Number(e.target.value);});
  if($('#gif-seconds'))$('#gif-seconds').addEventListener('change',e=>{j.gifSeconds=Number(e.target.value);});
  if($('#codec-select'))$('#codec-select').addEventListener('change',e=>{j.videoCodec=e.target.value;});
  if($('#audio-toggle'))$('#audio-toggle').addEventListener('click',()=>{j.includeAudio=!j.includeAudio;$('#audio-toggle').classList.toggle('on',j.includeAudio);$('#audio-toggle').setAttribute('aria-checked',String(j.includeAudio));});
  if($('#file-convert'))$('#file-convert').addEventListener('click',()=>convertFile(j));
  if($('#file-download'))$('#file-download').addEventListener('click',()=>downloadFile(j));
  if($('#file-compare'))$('#file-compare').addEventListener('click',()=>showCompare(j));
}
function renderActionButtons(){const list=visibleItems();const ready=list.filter(x=>['ready','error'].includes(x.status));const complete=list.filter(x=>x.status==='done');
  $('#convert-all').disabled=!ready.length;$('#download-all').hidden=!complete.length;
  $('#convert-all').innerHTML=`${icon('bolt')} Convert ${ready.length||'all'} ${icon('arrow')}`;}
function setCategory(kind){state.active=kind;state.selected=visibleItems()[0]?.id||null;render();}
function setView(which){state.view=which;$('#converter-view').hidden=which!=='workspace';$('#history-view').hidden=which!=='history';$('#crumb-current').textContent=which==='workspace'?'Converter':'History';$('#nav-workspace').classList.toggle('active',which==='workspace');$('#nav-history').classList.toggle('active',which==='history');$('#sidebar').classList.remove('open');if(which==='history')renderHistory();}
function removeItem(id){const idx=state.items.findIndex(x=>x.id===id);if(idx<0)return;const j=state.items[idx];if(j.status==='processing'||j.status==='uploading'||j.status==='queued'){toast('This conversion is running. Remove it after completion.');return;}if(j.previewObjectURL)URL.revokeObjectURL(j.previewObjectURL);if(j.outputObjectURL)URL.revokeObjectURL(j.outputObjectURL);if(j.serverId&&state.connected)fetch(state.api+'/api/jobs/'+j.serverId,{method:'DELETE',headers:authHeaders()}).catch(()=>{});state.items.splice(idx,1);if(state.selected===id)state.selected=visibleItems()[0]?.id||null;render();}
function clearAll(){for(const j of [...visibleItems()])removeItem(j.id);}
async function sniff(file){const buffer=await file.slice(0,40).arrayBuffer();const d=new Uint8Array(buffer);const ascii=(start,len)=>String.fromCharCode(...d.slice(start,start+len));
  if(d[0]===0xff&&d[1]===0xd8)return {type:'image',format:'jpg'};
  if(ascii(1,3)==='PNG')return {type:'image',format:'png'};
  if(ascii(0,4)==='GIF8')return {type:'image',format:'gif'};
  if(ascii(0,2)==='BM')return {type:'image',format:'bmp'};
  if(ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP')return {type:'image',format:'webp'};
  if(ascii(4,4)==='ftyp'){const brand=ascii(8,12);if(/heic|heix|hevc|mif1|heif|avif|avis/.test(brand))return {type:'image',format:brand.includes('avi')?'avif':'heic'};if(/qt  /.test(brand))return {type:'video',format:'mov'};return {type:'video',format:filenameExt(file.name)};}
  if(d[0]===0x1a&&d[1]===0x45&&d[2]===0xdf&&d[3]===0xa3)return {type:'video',format:filenameExt(file.name)};
  return {type:fileType(file.name,file.type),format:filenameExt(file.name)};
}
async function addFiles(files){const accepted=[];for(const file of [...files]){
  if(!file||file.size===0){toast('Empty files cannot be converted.');continue;}
  const kind=await sniff(file);if(!kind.type){toast(`${file.name}: unsupported media type`);continue;}
  const j={id:++fileId,file,name:file.name,kind:kind.type,format:kind.format||filenameExt(file.name),target:'',quality:state.defaultQuality,removeMetadata:false,
    status:'ready',progress:0,meta:{size:file.size},previewURL:null,previewObjectURL:null,outputURL:null,outputObjectURL:null,serverId:null,error:null,videoCodec:'auto',includeAudio:true,gifWidth:960,gifFPS:12,gifSeconds:0};
  j.target=defaultTarget(j);j.previewURL=URL.createObjectURL(file);j.previewObjectURL=j.previewURL;
  // Native probe only for browser-decodable formats. HEIC and professional codecs use the server.
  if(kind.type==='image'){
    if(['jpg','png','webp','gif','bmp','avif'].includes(j.format)){
      const img=new Image();img.onload=()=>{j.meta.width=img.naturalWidth;j.meta.height=img.naturalHeight;if(state.selected===j.id)renderInspector();};img.onerror=()=>{j.previewURL=null;if(state.selected===j.id)renderInspector();};img.src=j.previewObjectURL;
    }else j.previewURL=null;
  } else {
    const video=document.createElement('video');video.preload='metadata';video.onloadedmetadata=()=>{j.meta.width=video.videoWidth;j.meta.height=video.videoHeight;j.meta.duration=video.duration;if(state.selected===j.id)renderInspector();video.src='';};video.onerror=()=>{j.previewURL=null;};video.src=j.previewObjectURL;
  }
  state.items.push(j);accepted.push(j);
}
  if(accepted.length){state.active=accepted[0].kind;state.selected=accepted[0].id;setView('workspace');render();toast(`${accepted.length} file${accepted.length>1?'s':''} ready to convert.`);}
}
function authHeaders(){return state.apiKey?{'X-Forma-Key':state.apiKey}:{}}
function downloadBlob(url,name){const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();}
function downloadFile(j){if(j.status!=='done')return;if(j.serverId){downloadBlob(`${state.api}/api/jobs/${encodeURIComponent(j.serverId)}/download`,`${j.name.replace(/\.[^.]+$/,'')}_converted.${j.target}`);return;}
  if(j.outputURL)downloadBlob(j.outputURL,`${j.name.replace(/\.[^.]+$/,'')}_converted.${j.target}`);
}
function storeHistory(j){state.history.unshift({name:j.name,from:j.format,to:j.target,size:j.resultSize||j.file.size,at:Date.now()});state.history=state.history.slice(0,60);localStorage.setItem('forma-history',JSON.stringify(state.history));}
function renderHistory(){const el=$('#history-list');if(!state.history.length){el.innerHTML=`<div class="history-empty">No conversions yet. Your finished files will appear here.</div>`;return;}
  el.innerHTML=state.history.map(h=>`<div class="history-row">${icon('check')}<div class="history-file">${escapeHTML(h.name)}</div><div class="history-meta">${escapeHTML(h.from.toUpperCase())} → ${escapeHTML(h.to.toUpperCase())} &nbsp;·&nbsp; ${sizeLabel(h.size)} &nbsp;·&nbsp; ${new Date(h.at).toLocaleDateString()}</div></div>`).join('');}
async function convertLocal(j){
  const same=j.format===j.target;
  if(same&&!j.removeMetadata&&['maximum','lossless'].includes(j.quality)){
    j.outputURL=j.previewObjectURL;j.resultSize=j.file.size;return;
  }
  if(j.kind==='video')throw new Error('A conversion server is required for video transcoding. Configure it in Settings.');
  if(!offlineImages.includes(j.format)||!offlineImages.includes(j.target))throw new Error('This format requires the conversion server. Connect it in Settings.');
  if(j.quality==='lossless')throw new Error('True lossless with color profiles and metadata requires the server.');
  const img=await createImageBitmap(j.file);j.progress=15;render();
  const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
  if(img.width*img.height>90_000_000){img.close();throw new Error('Image too large for reliable browser conversion; use the server.');}
  const ctx=canvas.getContext('2d',{alpha:j.target!=='jpg',willReadFrequently:false});
  if(!ctx){img.close();throw new Error('Could not initialize image renderer');}
  if(j.target==='jpg'){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);}
  ctx.drawImage(img,0,0);img.close();
  const mime={jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[j.target];
  const q=j.quality==='maximum'?1:j.quality==='balanced'?.9:.74;
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Browser cannot encode this image format.')),mime,q));
  if(blob.type!==mime)throw new Error('This browser cannot encode the chosen format.');
  const outputURL=URL.createObjectURL(blob);j.outputURL=outputURL;j.outputObjectURL=outputURL;j.resultSize=blob.size;j.progress=100;
}
function uploadToServer(j){return new Promise((resolve,reject)=>{
  const request=new XMLHttpRequest();request.open('POST',state.api+'/api/jobs/upload');request.responseType='json';request.timeout=0;
  if(state.apiKey)request.setRequestHeader('X-Forma-Key',state.apiKey);
  request.upload.onprogress=e=>{if(e.lengthComputable){j.progress=Math.min(95,Math.round(e.loaded/e.total*100));renderQueue();renderInspector();}};
  request.onload=()=>{const data=request.response;request.status===201?resolve(data):reject(new Error(data?.detail||`Upload failed (HTTP ${request.status})`));};
  request.onerror=()=>reject(new Error('Cannot reach the conversion server. Check HTTPS and CORS settings.'));
  const fd=new FormData();fd.append('file',j.file,j.name);request.send(fd);
});}
async function convertServer(j){
  j.status='uploading';j.progress=0;render();const uploaded=await uploadToServer(j);j.serverId=uploaded.id;j.meta={...j.meta,...uploaded.metadata};
  if(j.kind==='image'&&!j.previewURL){j.previewURL=`${state.api}/api/jobs/${encodeURIComponent(j.serverId)}/preview`;}
  j.status='queued';j.progress=0;render();
  const response=await fetch(`${state.api}/api/jobs/${encodeURIComponent(j.serverId)}/convert`,{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({target:j.target,quality:j.quality,remove_metadata:j.removeMetadata,video_codec:j.videoCodec, audio:j.includeAudio,gif_width:j.gifWidth||null,gif_fps:j.gifFPS,gif_seconds:j.gifSeconds||null})});
  if(!response.ok){const err=await response.json().catch(()=>({}));throw new Error(err.detail||`Conversion could not start (HTTP ${response.status})`);}
  const started=Date.now();while(Date.now()-started<25*60*1000){
    await new Promise(done=>setTimeout(done,800));
    const poll=await fetch(`${state.api}/api/jobs/${encodeURIComponent(j.serverId)}`);
    if(!poll.ok)throw new Error('Cannot get conversion progress from the server.');
    const data=await poll.json();j.status=data.status;j.progress=data.progress||0;render();
    if(data.status==='done'){j.resultSize=data.size;j.outputURL=`${state.api}/api/jobs/${encodeURIComponent(j.serverId)}/download`;return;}
    if(data.status==='error')throw new Error(data.error||'Conversion failed');
  }
  throw new Error('Conversion did not finish within 25 minutes. Check your server.');
}
async function convertFile(j){if(!['ready','error'].includes(j.status))return;j.error=null;j.status='processing';j.progress=1;render();
  try{
    if(state.connected)await convertServer(j);else await convertLocal(j);
    j.status='done';j.progress=100;storeHistory(j);render();toast(`${j.name} converted successfully.`);
  }catch(err){j.status='error';j.error=err.message||String(err);j.progress=0;render();toast(j.error);}
}
async function convertAll(){const items=[...visibleItems()].filter(j=>['ready','error'].includes(j.status));if(!items.length)return;
  $('#convert-all').disabled=true;
  // Sequential by default to prevent memory spikes / protect small deployment servers.
  for(const j of items)await convertFile(j);
  toast('Batch processing finished.');
}
async function downloadAll(){const done=visibleItems().filter(j=>j.status==='done');if(!done.length)return;
  const remote=done.filter(j=>j.serverId);const local=done.filter(j=>!j.serverId);
  if(remote.length>=2&&state.connected){try{const response=await fetch(state.api+'/api/archive',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({ids:remote.map(j=>j.serverId)})});if(!response.ok)throw new Error('Archive generation failed');const blob=await response.blob();const href=URL.createObjectURL(blob);downloadBlob(href,'forma-converted.zip');setTimeout(()=>URL.revokeObjectURL(href),60_000);}catch{toast('ZIP could not be created. Downloading individually.');remote.forEach(downloadFile);}}
  else remote.forEach(downloadFile);
  if(local.length>1)toast('Browser-only files download individually. Connect the server for ZIP downloads.');
  local.forEach((j,i)=>setTimeout(()=>downloadFile(j),i*450));
}
function showCompare(j){if(!j.outputURL||!j.previewURL){toast('No compatible image preview is available.');return;}
  $('#compare-original').src=j.previewURL;$('#compare-result').src=j.outputURL;
  $('#compare-range').value='50';updateCompare(50);$('#compare-modal').hidden=false;}
function updateCompare(value){$('#compare-after').style.clipPath=`inset(0 0 0 ${value}%)`;$('#compare-line').style.left=value+'%';}
function openSettings(){ $('#api-url').value=state.api;$('#api-key').value=state.apiKey;$('#default-quality').value=state.defaultQuality;$('#connection-message').textContent=state.connected?'Connected. Advanced conversions are available.':'Browser-only mode: connect a server for full functionality.';$('#connection-message').className='connection-message'+(state.connected?' ok':'');$('#settings-modal').hidden=false;}
function normalizedUrl(value){return value.trim().replace(/\/+$/,'');}
async function testAPI(value,save=false){const url=normalizedUrl(value);const pendingKey=($('#api-key').value||'').trim();if(!url){state.connected=false;state.capabilities=null;if(save){state.api='';localStorage.removeItem('forma-api');}$('#connection-message').textContent='No server configured. Browser-only image conversion remains available.';$('#connection-message').className='connection-message';render();return false;}
  if(!/^https?:\/\//i.test(url)){ $('#connection-message').textContent='Enter a valid http(s) URL.';$('#connection-message').className='connection-message fail';return false;}
  if(location.protocol==='https:'&&url.startsWith('http:')){$('#connection-message').textContent='HTTPS websites require an HTTPS backend URL.';$('#connection-message').className='connection-message fail';return false;}
  $('#connection-message').textContent='Checking connection…';$('#connection-message').className='connection-message';
  try{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),75000);let r,c;
    try{[r,c]=await Promise.all([fetch(url+'/api/health',{signal:controller.signal}),fetch(url+'/api/capabilities',{signal:controller.signal})]);}finally{clearTimeout(timer);}
    if(!r.ok||!c.ok)throw new Error(`HTTP ${r.status} / ${c.status}`);
    const health=await r.json();const caps=await c.json();if(!health.ok||!Array.isArray(caps.imageOutputs))throw new Error('Not a compatible Forma API');
    const auth=await fetch(url+'/api/auth/check',{signal:controller.signal,headers:pendingKey?{'X-Forma-Key':pendingKey}:{}});
    if(!auth.ok)throw new Error(auth.status===401?'Invalid or missing server access key':`Access check failed (HTTP ${auth.status})`);
    state.connected=true;state.capabilities=caps;state.api=url;state.apiKey=pendingKey;
    if(save){localStorage.setItem('forma-api',url);if(pendingKey)localStorage.setItem('forma-api-key',pendingKey);else localStorage.removeItem('forma-api-key');}
    $('#connection-message').textContent=`Connected! HEIC: ${caps.heic?'yes':'no'} · RAW: ${caps.raw?'yes':'no'} · Video: enabled`;
    $('#connection-message').className='connection-message ok';render();return true;
  }catch(e){state.connected=false;state.capabilities=null;$('#connection-message').textContent=`Connection failed: ${e.message}. Ensure CORS_ORIGINS includes this site's exact origin.`;$('#connection-message').className='connection-message fail';render();return false;}
}
function closeSettings(){$('#settings-modal').hidden=true;}
function closeCompare(){$('#compare-modal').hidden=true;}
$('#file-input').addEventListener('change',async e=>{await addFiles(e.target.files);e.target.value='';});
function browse(){ $('#file-input').click();}
$('#dropzone').addEventListener('click',e=>{if(!e.target.closest('#browse-inline'))browse();});
$('#dropzone').addEventListener('keydown',e=>{if(e.target===$('#dropzone')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();browse();}});
$('#browse-inline').addEventListener('click',e=>{e.stopPropagation();browse();});
$('#top-add').addEventListener('click',browse);$('#add-more').addEventListener('click',browse);
$('#clear-all').addEventListener('click',clearAll);$('#tab-image').addEventListener('click',()=>setCategory('image'));$('#tab-video').addEventListener('click',()=>setCategory('video'));
$('#convert-all').addEventListener('click',convertAll);$('#download-all').addEventListener('click',downloadAll);
$('#nav-workspace').addEventListener('click',()=>setView('workspace'));$('#nav-history').addEventListener('click',()=>setView('history'));
$('#nav-settings').addEventListener('click',openSettings);$('#top-settings').addEventListener('click',openSettings);$('#engine-mini').addEventListener('click',openSettings);
$('#nav-theme').addEventListener('click',()=>setTheme(state.theme==='dark'?'light':'dark'));
$('#mobile-menu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#close-settings').addEventListener('click',closeSettings);$('#close-compare').addEventListener('click',closeCompare);
$('#settings-modal').addEventListener('click',e=>{if(e.target.id==='settings-modal')closeSettings();});
$('#compare-modal').addEventListener('click',e=>{if(e.target.id==='compare-modal')closeCompare();});
$('#compare-range').addEventListener('input',e=>updateCompare(e.target.value));
$('#test-api').addEventListener('click',()=>testAPI($('#api-url').value));
$('#save-settings').addEventListener('click',async()=>{const url=normalizedUrl($('#api-url').value);state.defaultQuality=$('#default-quality').value;localStorage.setItem('forma-quality',state.defaultQuality);
  if(!url){state.api='';state.apiKey='';state.connected=false;state.capabilities=null;localStorage.removeItem('forma-api');localStorage.removeItem('forma-api-key');closeSettings();render();toast('Settings saved. Browser-only mode.');return;}
  if(await testAPI(url,true)){closeSettings();toast('Conversion server connected.');}
});
$('#modal-theme').addEventListener('click',()=>setTheme(state.theme==='dark'?'light':'dark'));
$('#history-clear').addEventListener('click',()=>{state.history=[];localStorage.removeItem('forma-history');renderHistory();toast('History cleared.');});
let dragged=0;window.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types||[]].includes('Files')){e.preventDefault();dragged++;$('#dropzone').classList.add('dragging');}});
window.addEventListener('dragover',e=>{if([...e.dataTransfer?.types||[]].includes('Files'))e.preventDefault();});
window.addEventListener('dragleave',e=>{dragged=Math.max(0,dragged-1);if(!dragged)$('#dropzone').classList.remove('dragging');});
window.addEventListener('drop',async e=>{e.preventDefault();dragged=0;$('#dropzone').classList.remove('dragging');if(e.dataTransfer?.files?.length)await addFiles(e.dataTransfer.files);});
window.addEventListener('paste',async e=>{if(!$('#settings-modal').hidden)return;const files=[...e.clipboardData?.items||[]].map(i=>i.kind==='file'?i.getAsFile():null).filter(Boolean);if(files.length)await addFiles(files);});
window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeSettings();closeCompare();$('#sidebar').classList.remove('open');}
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();browse();}
  if((e.ctrlKey||e.metaKey)&&e.key==='1'){e.preventDefault();setCategory('image');setView('workspace');}
  if((e.ctrlKey||e.metaKey)&&e.key==='2'){e.preventDefault();setCategory('video');setView('workspace');}
});
render();if(state.api){$('#api-key').value=state.apiKey;testAPI(state.api);}renderHistory();
