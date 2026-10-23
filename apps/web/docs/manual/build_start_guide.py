"""Build the Korean public guide from reviewed content. Requires ReportLab and Malgun."""
import json
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/manuals/byeollog-start-guide.pdf'
pages = json.loads(Path(__file__).with_name('start-guide.json').read_text(encoding='utf-8'))
pdfmetrics.registerFont(TTFont('Malgun', 'C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('MalgunBold', 'C:/Windows/Fonts/malgunbd.ttf'))
W, H = 595.28, 841.89
body = ParagraphStyle('body', fontName='Malgun', fontSize=11.5, leading=19, textColor=HexColor('#30445f'), wordWrap='CJK')
bold = ParagraphStyle('heading', parent=body, fontName='MalgunBold', fontSize=13, leading=21, textColor=HexColor('#132943'))
c = canvas.Canvas(str(OUT), pagesize=(W,H), invariant=1)
c.setTitle('별록 설정 매뉴얼 | 2026-10-11')
c.setAuthor('BYEOLLOG')
for i, (title, subtitle, sections) in enumerate(pages, 1):
    c.setFillColor(HexColor('#f3f6fa')); c.rect(0,0,W,H,fill=1,stroke=0)
    c.setFillColor(HexColor('#102640')); c.rect(0,H-160,W,160,fill=1,stroke=0)
    c.setFillColor(HexColor('#ffcf67')); c.setFont('MalgunBold',10); c.drawString(38,H-35,'BYEOLLOG  /  설정 매뉴얼')
    c.setFillColor(HexColor('#ffffff')); c.setFont('MalgunBold',24); c.drawString(38,H-83,title)
    c.setFillColor(HexColor('#d7e3f1')); c.setFont('Malgun',10.5); c.drawString(38,H-116,subtitle)
    y=H-182
    for heading, content in sections:
        hp=Paragraph(escape(heading),bold); _,hh=hp.wrap(W-108,100)
        bp=Paragraph(escape(content).replace('\n','<br/>'),body); _,bh=bp.wrap(W-108,600)
        height=hh+bh+35
        assert y-height>58, (i,heading,y,height)
        c.setFillColor(HexColor('#ffffff')); c.roundRect(38,y-height,W-76,height,10,fill=1,stroke=0)
        hp.drawOn(c,54,y-14-hh); bp.drawOn(c,54,y-20-hh-bh)
        y-=height+12
    c.setStrokeColor(HexColor('#cbd6e4')); c.line(38,46,W-38,46)
    c.setFillColor(HexColor('#536782')); c.setFont('Malgun',8)
    c.drawString(38,28,'2026.10.11 · 웹 현행 안내 / Windows Agent 1.0.0.56')
    c.drawRightString(W-38,28,f'{i:02} / {len(pages):02}')
    c.showPage()
c.save()
print(f'Wrote {len(pages)} pages: {OUT}')
