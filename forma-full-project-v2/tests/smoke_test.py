"""Run `python tests/smoke_test.py` with FastAPI, Pillow, FFmpeg installed."""
import asyncio
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
import main
from PIL import Image
from fastapi.testclient import TestClient

def check():
    client=TestClient(main.app)
    assert client.get('/api/health').json()['ok']
    png=io.BytesIO()
    Image.new('RGB',(80,60),(52,128,225)).save(png,'PNG')
    r=client.post('/api/jobs/upload',files={'file':('image.png',png.getvalue(),'image/png')})
    assert r.status_code==201,r.text
    data=r.json();iid=data['id'];assert data['metadata']['width']==80
    assert 'jpg' in data['outputs']
    # Function-level image test — integration tested separately for async background.
    j=main.get_job(iid)
    output=main.transcode_image(iid,j,main.ConvertOptions(target='jpg'))
    with Image.open(output) as im: assert im.format=='JPEG' and im.size==(80,60)
    main.update(iid,status='done',target='jpg',output=output,size=output.stat().st_size)
    assert client.get(f'/api/jobs/{iid}/download').status_code==200
    vid=Path(tempfile.mktemp(suffix='.mp4'))
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i',
                    'testsrc2=size=128x72:rate=12','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p',str(vid)],check=True)
    try:
        with vid.open('rb') as f:r=client.post('/api/jobs/upload',files={'file':('clip.mp4',f,'video/mp4')})
        assert r.status_code==201,r.text
        data=r.json();vid_id=data['id'];assert data['metadata']['codec']=='h264'
        j=main.get_job(vid_id)
        output=main.transcode_video(vid_id,j,main.ConvertOptions(target='mkv'))
        assert output.exists() and output.stat().st_size>0
        probe=main.ffprobe(output)
        assert any(s['codec_type']=='video' for s in probe['streams'])
        assert main.video_copy_possible(data['metadata'],'mkv',main.ConvertOptions(target='mkv'))
        gif=main.transcode_video(vid_id,j,main.ConvertOptions(target='gif',gif_width=960,gif_fps=10,gif_seconds=1))
        assert gif.exists() and gif.stat().st_size > 0
        assert main.ffprobe(gif)['streams'][0]['codec_name']=='gif'
    finally:vid.unlink(missing_ok=True)
    print('PASS: image upload, format detection, JPG encode, output download, video upload, remux, FFprobe, GIF export')

if __name__=='__main__':check()
