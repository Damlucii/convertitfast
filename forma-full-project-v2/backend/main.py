"""Forma Media Converter API. One-process, self-hosted personal conversion worker.
Uploads are stored in temporary, random per-job directories and automatically expire.
Run one uvicorn worker; job status is intentionally in-process, not distributed.
"""
from __future__ import annotations
import asyncio
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError, features

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HAS_HEIF = True
except ImportError:
    HAS_HEIF = False
try:
    import rawpy
    HAS_RAW = True
except ImportError:
    HAS_RAW = False

IMAGE_INPUTS = {'jpg','jpeg','png','webp','gif','bmp','tiff','tif','ico','heic','heif','avif','jp2','j2k','tga','psd'}
RAW_INPUTS = {'dng','cr2','cr3','nef','arw','raf','orf','rw2','pef'}
VIDEO_INPUTS = {'mp4','mov','mkv','webm','avi','wmv','flv','mpeg','mpg','m4v','3gp','ts','mts','m2ts','ogv','vob'}
IMAGE_OUTPUTS = ['jpg','png','webp','tiff','bmp','gif','ico']
if features.check('avif'):
    IMAGE_OUTPUTS.append('avif')
if HAS_HEIF:
    IMAGE_OUTPUTS.append('heic')
VIDEO_OUTPUTS = ['mp4','mov','mkv','webm','avi','gif']
MIME = {'jpg':'image/jpeg','png':'image/png','webp':'image/webp','tiff':'image/tiff','bmp':'image/bmp',
        'gif':'image/gif','ico':'image/x-icon','avif':'image/avif','heic':'image/heic',
        'mp4':'video/mp4','mov':'video/quicktime','mkv':'video/x-matroska','webm':'video/webm',
        'avi':'video/x-msvideo'}
EXT_FIX = {'jpeg':'jpg','tif':'tiff'}
DATA_DIR = Path(os.getenv('DATA_DIR', tempfile.gettempdir() + '/forma-jobs'))
DATA_DIR.mkdir(parents=True, exist_ok=True)
MAX_BYTES = int(os.getenv('MAX_UPLOAD_MB', '2048')) * 1024 * 1024
TTL_SECONDS = int(os.getenv('JOB_TTL_SECONDS', '3600'))
MAX_CONCURRENT = max(1, int(os.getenv('MAX_CONCURRENT_JOBS', '2')))
WORKERS = ThreadPoolExecutor(max_workers=MAX_CONCURRENT)
WORK_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)
API_ACCESS_KEY = os.getenv('API_ACCESS_KEY','').strip()
ORIGINS = [x.strip() for x in os.getenv('CORS_ORIGINS','http://localhost:8888,http://localhost:5173,http://127.0.0.1:8888').split(',') if x.strip()]
app = FastAPI(title='Forma Converter API', version='1.0.0', docs_url='/docs')
app.add_middleware(CORSMiddleware,allow_origins=ORIGINS, allow_credentials=False,
                   allow_methods=['GET','POST','DELETE'], allow_headers=['Content-Type','X-Forma-Key'])
jobs: dict[str, dict] = {}
lock = Lock()

class ConvertOptions(BaseModel):
    target: str = Field(min_length=2,max_length=6)
    quality: Literal['maximum','lossless','balanced','small'] = 'maximum'
    remove_metadata: bool = False
    video_codec: Literal['auto','h264','h265','vp9','av1','ffv1'] = 'auto'
    audio: bool = True
    gif_width: int | None = Field(default=960, ge=160, le=7680)  # None = original width
    gif_fps: int = Field(default=12, ge=1, le=60)
    gif_seconds: int | None = Field(default=None, ge=1, le=600)  # None = entire clip

class ArchiveRequest(BaseModel):
    ids: list[str] = Field(min_length=1,max_length=100)

def trim():
    now = time.time()
    with lock:
        old = [jid for jid,j in jobs.items() if now-j['created']>TTL_SECONDS and j['status']!='processing']
        for jid in old:
            j = jobs.pop(jid)
            shutil.rmtree(j['folder'], ignore_errors=True)

def get_job(jid: str):
    with lock:
        j = jobs.get(jid)
    if not j: raise HTTPException(404, 'Job not found or expired')
    return j

def update(jid: str, **kwargs):
    with lock:
        if jid in jobs: jobs[jid].update(kwargs)

def ffprobe(path):
    cp = subprocess.run(['ffprobe','-v','quiet','-print_format','json','-show_format','-show_streams',str(path)],
                        capture_output=True,text=True,timeout=45,check=False)
    if cp.returncode != 0: raise ValueError('Cannot read video container or streams.')
    return json.loads(cp.stdout)

def safe_ext(name: str):
    return Path(name).suffix.lower().lstrip('.')[:8]

def identify(path, original_name):
    suffix = safe_ext(original_name)
    if suffix in RAW_INPUTS and HAS_RAW:
        try:
            with rawpy.imread(str(path)) as raw:
                shape = raw.raw_image.shape
            return {'type':'image','format':suffix,'width':int(shape[1]),'height':int(shape[0]),'codec':'RAW',
                    'size':path.stat().st_size,'note':'RAW image dimensions; visible crop may differ'}
        except Exception: pass
    try:
        with Image.open(path) as im:
            fmt = (im.format or suffix).lower()
            fmt = {'jpeg':'jpg','tiff':'tiff','heif':'heic'}.get(fmt,fmt)
            return {'type':'image','format':fmt,'width':im.width,'height':im.height,
                    'frames':getattr(im,'n_frames',1),'alpha':('A' in im.getbands() or 'transparency' in im.info),
                    'size':path.stat().st_size,'mode':im.mode,'hasICC':bool(im.info.get('icc_profile')),
                    'hasEXIF':bool(im.info.get('exif'))}
    except (UnidentifiedImageError,OSError,ValueError): pass
    if suffix in VIDEO_INPUTS or suffix not in IMAGE_INPUTS | RAW_INPUTS:
        try:
            data=ffprobe(path)
            v=next((s for s in data['streams'] if s.get('codec_type')=='video'),None)
            if not v: raise ValueError('No video stream found')
            a=next((s for s in data['streams'] if s.get('codec_type')=='audio'),None)
            dur=float(data.get('format',{}).get('duration') or v.get('duration') or 0)
            fr=v.get('avg_frame_rate','0/1').split('/')
            fps=round(float(fr[0])/float(fr[1]),3) if len(fr)==2 and float(fr[1]) else 0
            return {'type':'video','format':suffix or data.get('format',{}).get('format_name','video').split(',')[0],
                    'width':v.get('width'), 'height':v.get('height'), 'codec':v.get('codec_name'),
                    'audioCodec':a.get('codec_name') if a else None,'duration':dur,'fps':fps,
                    'bitDepth':v.get('bits_per_raw_sample') or None,'size':path.stat().st_size,
                    'bitrate':int(data.get('format',{}).get('bit_rate') or 0),
                    'colorspace':v.get('color_space'), 'transfer':v.get('color_transfer')}
        except Exception: pass
    raise ValueError('Unsupported or invalid media file')

@app.get('/api/health')
def health():
    return {'ok':True,'engine':'Forma API','heic':HAS_HEIF,'raw':HAS_RAW}

@app.get('/api/capabilities')
def capabilities():
    return {'imageOutputs':IMAGE_OUTPUTS,'videoOutputs':VIDEO_OUTPUTS,'heic':HAS_HEIF,'raw':HAS_RAW,
            'maxUploadMB': MAX_BYTES//(1024*1024), 'maxConcurrentJobs':MAX_CONCURRENT}

def require_access(request: Request):
    # CORS does not authenticate API calls; a private per-user key protects uploads.
    if API_ACCESS_KEY and not secrets.compare_digest(request.headers.get('X-Forma-Key',''), API_ACCESS_KEY):
        raise HTTPException(401, 'Invalid or missing API access key')

@app.get('/api/auth/check')
def check_access(_: None = Depends(require_access)):
    return {'ok':True}

@app.post('/api/jobs/upload',status_code=201)
async def upload(file: UploadFile=File(...), _:None=Depends(require_access)):
    trim()
    # Strict max-size streaming; never trust Content-Length or client MIME.
    jid=secrets.token_urlsafe(19)
    folder=DATA_DIR/jid
    folder.mkdir(mode=0o700)
    source=folder/'source.bin'
    total=0
    try:
        with source.open('wb') as f:
            while chunk:=await file.read(1024*1024):
                total+=len(chunk)
                if total>MAX_BYTES: raise HTTPException(413,'File exceeds configured maximum size')
                f.write(chunk)
        if total==0: raise HTTPException(400,'Empty file')
        name=Path(file.filename or 'media').name
        meta=await asyncio.to_thread(identify,source,name)
        jid_obj={'id':jid,'folder':folder,'source':source,'originalName':name,'meta':meta,
                 'created':time.time(),'status':'ready','progress':0,'output':None,'target':None,'error':None}
        with lock: jobs[jid]=jid_obj
        outputs=IMAGE_OUTPUTS if meta['type']=='image' else VIDEO_OUTPUTS
        return {'id':jid,'metadata':meta,'outputs':outputs}
    except HTTPException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(415, f'Cannot decode or inspect this file: {str(exc)[:180]}')
    finally:
        await file.close()

@app.get('/api/jobs/{jid}/preview')
def preview(jid:str):
    j=get_job(jid)
    if j['meta']['type']!='image': raise HTTPException(400,'Preview only for images')
    try:
        with open_image(j) as im:
            im=ImageOps.exif_transpose(im)
            im.thumbnail((1400,1400), Image.Resampling.LANCZOS)
            if im.mode not in ('RGB','L'): im=im.convert('RGB')
            b=io.BytesIO(); im.save(b,'JPEG',quality=90)
        return Response(b.getvalue(), media_type='image/jpeg',headers={'Cache-Control':'private, max-age=3600'})
    except Exception: raise HTTPException(422,'Cannot generate preview')

def open_image(j):
    if j['meta']['format'] in RAW_INPUTS:
        if not HAS_RAW: raise ValueError('RAW decoder unavailable')
        with rawpy.imread(str(j['source'])) as raw:
            arr=raw.postprocess(use_camera_wb=True,output_bps=8, no_auto_bright=True)
        return Image.fromarray(arr)
    return Image.open(j['source'])

def transcode_image(jid, j, o):
    target=o.target
    if target not in IMAGE_OUTPUTS: raise ValueError('Unsupported image output on this server')
    if o.quality=='lossless' and target in {'jpg','gif','bmp','ico'}:
        raise ValueError('This output cannot preserve all input pixel information losslessly')
    if o.quality=='lossless' and target in {'heic','avif'}:
        raise ValueError('Lossless encoding not guaranteed for this output format')
    ext=target
    out=j['folder']/('result.'+ext)
    quality={'maximum':100,'balanced':88,'small':72,'lossless':100}[o.quality]
    # 16-bit RAW → TIFF: avoid squeezing a 16-bit/channel raw developer output
    # through Pillow's 8-bit RGB representation. Other targets use 8-bit RGB.
    if j['meta']['format'] in RAW_INPUTS and target=='tiff':
        if not HAS_RAW: raise ValueError('RAW decoder unavailable')
        try:
            import tifffile
            with rawpy.imread(str(j['source'])) as raw:
                pixels=raw.postprocess(use_camera_wb=True, output_bps=16, no_auto_bright=True)
            tifffile.imwrite(out, pixels, photometric='rgb', compression='deflate')
            with Image.open(out) as check:
                assert check.width==pixels.shape[1] and check.height==pixels.shape[0]
            update(jid,progress=98)
            return out
        except ImportError as exc:
            raise ValueError('16-bit RAW export requires tifffile') from exc
    with open_image(j) as original:
        if getattr(original,'n_frames',1)>1 and target not in {'gif','webp'}:
            raise ValueError('Animated input requires GIF or WebP output (or select single frame in a future edition)')
        animated=getattr(original,'n_frames',1)>1
        if animated and target in {'gif','webp'}:
            durations=[]
            frames=[]
            loop=original.info.get('loop',0)
            for frame in ImageSequence.Iterator(original):
                durations.append(frame.info.get('duration',original.info.get('duration',100)) or 100)
                frames.append(frame.convert('RGBA'))
            if not frames: raise ValueError('No frames found in animation')
            update(jid,progress=30)
            if target=='webp':
                frames[0].save(out,format='WEBP',save_all=True,append_images=frames[1:],duration=durations,
                               loop=loop,lossless=(o.quality in {'maximum','lossless'}),quality=quality,method=6)
            else:
                frames[0].save(out,format='GIF',save_all=True,append_images=frames[1:],duration=durations,
                               loop=loop,optimize=True,disposal=2)
            with Image.open(out) as check:
                if getattr(check,'n_frames',1)<2: raise ValueError('Animated output lost its frames')
            update(jid,progress=98)
            return out
        original.seek(0)
        icc=original.info.get('icc_profile')
        exif=original.info.get('exif')
        im=ImageOps.exif_transpose(original)
        im.load()
        options={}
        if not o.remove_metadata:
            if icc and target in {'jpg','png','webp','tiff'}: options['icc_profile']=icc
            if exif and target in {'jpg','png','webp','tiff'}:
                # exif_transpose ensures orientation is removed or rewritten.
                try:options['exif']=im.getexif().tobytes()
                except Exception:pass
        update(jid,progress=30)
        if target=='jpg':
            if im.mode not in ('RGB','L'):
                if 'A' in im.getbands() or 'transparency' in im.info:
                    raise ValueError('JPEG cannot store transparency. Use PNG or WebP.')
                im=im.convert('RGB')
            im.save(out,'JPEG',quality=quality,subsampling=0,optimize=True,**options)
        elif target=='png':
            im.save(out,'PNG',optimize=True,**options)
        elif target=='webp':
            im.save(out,'WEBP',lossless=(o.quality in {'maximum','lossless'}),method=6,
                    quality=quality,**options)
        elif target=='tiff':
            im.save(out,'TIFF',compression='tiff_lzw',**options)
        elif target=='bmp':
            im.save(out,'BMP')
        elif target=='gif':
            if o.quality=='lossless':raise ValueError('GIF has a 256-color palette and cannot preserve general image pixels losslessly')
            im.convert('RGB').save(out,'GIF',optimize=True)
        elif target=='ico':
            if im.width>256 or im.height>256:
                raise ValueError('ICO is limited to 256x256. This converter never resizes automatically.')
            im.save(out,'ICO')
        elif target=='avif':
            im.save(out,'AVIF',quality=quality, speed=2)
        elif target=='heic':
            im.save(out,'HEIF',quality=quality)
    with Image.open(out) as valid:
        valid.load()
        outformat=(valid.format or target).lower()
        if valid.width!=j['meta']['width'] or valid.height!=j['meta']['height']:
            if j['meta']['format'] not in RAW_INPUTS:raise ValueError('Output dimensions changed unexpectedly')
    update(jid,progress=98)
    return out

def video_copy_possible(meta,target,o):
    if o.video_codec!='auto' or o.quality=='lossless':return False
    vc=meta.get('codec'); ac=meta.get('audioCodec')
    audio_ok=lambda allowed: (not o.audio) or (not ac) or ac in allowed
    if target in {'mp4','mov'}: return vc in {'h264','hevc','av1','mpeg4'} and audio_ok({'aac','mp3','alac'})
    if target=='webm':return vc in {'vp8','vp9','av1'} and audio_ok({'opus','vorbis'})
    if target=='mkv':return vc in {'h264','hevc','av1','vp8','vp9','ffv1','mpeg4','prores'}
    if target=='avi':return vc in {'mpeg4','mjpeg'} and audio_ok({'mp3','pcm_s16le'})
    return False

def transcode_video(jid,j,o):
    target=o.target
    if target not in VIDEO_OUTPUTS:raise ValueError('Unsupported video output')
    if o.quality=='lossless' and target!='mkv':
        raise ValueError('True lossless video encoding is available as MKV / FFV1 only')
    if target=='gif' and o.quality=='lossless':raise ValueError('GIF is palette-limited and cannot guarantee lossless video')
    if o.video_codec=='ffv1' and target!='mkv':raise ValueError('FFV1 requires MKV here')
    if o.video_codec in {'vp9','av1'} and target not in {'webm','mkv'}:
        raise ValueError('Selected video codec is not supported for this container configuration')
    if o.video_codec in {'h264','h265'} and target=='webm':
        raise ValueError('WebM requires VP9/AV1 in this converter')
    out=j['folder']/('result.'+target)
    source=j['source']
    copy=video_copy_possible(j['meta'],target,o)
    args=['ffmpeg','-hide_banner','-nostdin','-y','-i',str(source),'-map','0:v:0']
    if o.audio and target!='gif': args+=['-map','0:a?']
    args+=['-map_metadata','-1' if o.remove_metadata else '0']
    if copy:
        args+=['-c:v','copy']
        if o.audio:args+=['-c:a','copy']
        if target in {'mp4','mov'}:args+=['-movflags','+faststart']
    elif target=='gif':
        # A GIF has at most 256 palette colors, so it is never true lossless for video.
        # Expose output dimensions/FPS to the user instead of silently degrading 4K input.
        scale='iw:ih' if o.gif_width is None else f'min({o.gif_width}\\,iw):-2'
        vf=(f'[0:v]fps={o.gif_fps},scale={scale}:flags=lanczos,split[a][b];'
            '[a]palettegen=max_colors=256:stats_mode=full[p];'
            '[b][p]paletteuse=dither=sierra2_4a[v]')
        args+=['-filter_complex',vf,'-map','[v]','-an']
        # Remove the initial input video map. Filtergraph output must be mapped instead.
        vi=args.index('-map');del args[vi:vi+2]
    elif o.quality=='lossless' or o.video_codec=='ffv1':
        args+=['-c:v','ffv1','-level','3','-c:a','flac']
    else:
        vc=o.video_codec
        if vc=='auto':vc={'mp4':'h264','mov':'h264','mkv':'h265','webm':'vp9','avi':'h264'}.get(target,'h264')
        if target=='avi' and vc=='h264':vc='mpeg4'
        if vc=='h264':
            crf={'maximum':14,'balanced':21,'small':28}[o.quality]
            args+=['-c:v','libx264','-preset','slow' if o.quality=='maximum' else 'medium','-crf',str(crf),'-pix_fmt','yuv420p']
        elif vc=='h265':
            crf={'maximum':16,'balanced':23,'small':29}[o.quality]
            args+=['-c:v','libx265','-preset','slow' if o.quality=='maximum' else 'medium','-crf',str(crf),'-pix_fmt','yuv420p10le']
        elif vc=='vp9':
            crf={'maximum':15,'balanced':26,'small':36}[o.quality]
            args+=['-c:v','libvpx-vp9','-b:v','0','-crf',str(crf),'-row-mt','1','-pix_fmt','yuv420p']
        elif vc=='av1':
            crf={'maximum':20,'balanced':30,'small':40}[o.quality]
            args+=['-c:v','libaom-av1','-cpu-used','4','-b:v','0','-crf',str(crf)]
        else:
            args+=['-c:v','mpeg4','-q:v','2' if o.quality=='maximum' else '5']
        if o.audio:
            if target=='webm':args+=['-c:a','libopus','-b:a','192k']
            elif target=='avi':args+=['-c:a','libmp3lame','-b:a','256k']
            else:args+=['-c:a','aac','-b:a','320k' if o.quality=='maximum' else '192k']
        if target in {'mp4','mov'}:args+=['-movflags','+faststart']
    if target=='gif' and o.gif_seconds is not None:
        args+=['-t',str(o.gif_seconds)]
    args+=['-progress','pipe:1','-nostats',str(out)]
    errfile=j['folder']/'ffmpeg.err'
    with errfile.open('wb') as ferr:
        proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=ferr,text=True,bufsize=1)
        try:
            duration=float(j['meta'].get('duration') or 0)
            if target=='gif' and o.gif_seconds is not None:
                duration=min(duration, o.gif_seconds) if duration else float(o.gif_seconds)
            for line in proc.stdout:
                if line.startswith('out_time='):
                    stamp=line.split('=',1)[1].strip()
                    try:
                        hh,mm,ss=stamp.split(':');secs=float(hh)*3600+float(mm)*60+float(ss)
                        update(jid,progress=min(97,max(2,round(secs/duration*100))) if duration else 0)
                    except (ValueError,ZeroDivisionError):pass
            code=proc.wait(timeout=30)
        except Exception:
            proc.kill();proc.wait();raise
    if code:
        detail=errfile.read_text(errors='replace')[-550:]
        raise ValueError('FFmpeg failed: '+detail)
    check=ffprobe(out)
    if not next((s for s in check.get('streams',[]) if s.get('codec_type')=='video'),None):
        raise ValueError('Result does not contain a valid video stream')
    return out

async def process(jid, o):
    j=get_job(jid)
    async with WORK_SEMAPHORE:
        update(jid,status='processing',progress=1)
        try:
            fn=transcode_image if j['meta']['type']=='image' else transcode_video
            out=await asyncio.get_running_loop().run_in_executor(WORKERS,fn,jid,j,o)
            update(jid,status='done',progress=100,output=out,target=o.target,size=out.stat().st_size)
        except Exception as exc:
            update(jid,status='error',progress=0,error=str(exc)[:1000])

@app.post('/api/jobs/{jid}/convert',status_code=202)
async def convert(jid:str, o:ConvertOptions, _:None=Depends(require_access)):
    j=get_job(jid)
    if j['status'] in ('processing','queued'):raise HTTPException(409,'Already processing')
    if j['status']=='done':raise HTTPException(409,'Already converted; upload again for a new setting')
    target=EXT_FIX.get(o.target.lower(),o.target.lower())
    o.target=target
    outputs=IMAGE_OUTPUTS if j['meta']['type']=='image' else VIDEO_OUTPUTS
    if target not in outputs:raise HTTPException(422,'Unavailable output format')
    update(jid,status='queued',progress=0,error=None)
    asyncio.create_task(process(jid,o))
    return {'id':jid,'status':'queued'}

@app.get('/api/jobs/{jid}')
def status(jid:str):
    trim()
    j=get_job(jid)
    return {'id':jid,'status':j['status'],'progress':j['progress'],'error':j['error'],
            'size':j.get('size'),'target':j.get('target'),'metadata':j['meta']}

@app.get('/api/jobs/{jid}/download')
def download(jid:str):
    j=get_job(jid)
    if j['status']!='done' or not j.get('output') or not j['output'].exists():
        raise HTTPException(409,'Conversion not finished')
    target=j['target'];stem=re.sub(r'[^a-zA-Z0-9_ .()\-]','_',Path(j['originalName']).stem)[:100] or 'converted'
    return FileResponse(j['output'], media_type=MIME.get(target,'application/octet-stream'),
                        filename=stem+'_converted.'+target)

@app.post('/api/archive')
def archive(data:ArchiveRequest, _:None=Depends(require_access)):
    files=[]
    for jid in data.ids:
        j=get_job(jid)
        if j['status']!='done' or not j.get('output'):raise HTTPException(409,'Some jobs are not ready')
        files.append(j)
    if sum(j['output'].stat().st_size for j in files)>400*1024*1024:
        raise HTTPException(413,'Archive too big; download files individually')
    tmp=DATA_DIR/('archive-'+secrets.token_urlsafe(12)+'.zip')
    with zipfile.ZipFile(tmp,'w',zipfile.ZIP_DEFLATED,compresslevel=2) as z:
        for i,j in enumerate(files):
            name=re.sub(r'[^a-zA-Z0-9_ .()\-]','_',Path(j['originalName']).stem)[:80]
            z.write(j['output'],f'{i+1:02d}-{name}.{j["target"]}')
    from starlette.background import BackgroundTask
    return FileResponse(tmp, media_type='application/zip', filename='forma-converted.zip',
                        background=BackgroundTask(lambda:tmp.unlink(missing_ok=True)))

@app.delete('/api/jobs/{jid}')
def delete(jid:str, _:None=Depends(require_access)):
    j=get_job(jid)
    if j['status'] in ('queued','processing'):
        raise HTTPException(409,'Job is currently processing; wait until it finishes')
    with lock:jobs.pop(jid,None)
    shutil.rmtree(j['folder'],ignore_errors=True)
    return {'ok':True}
