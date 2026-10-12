"""Generate labelled synthetic screenshots, never real receipts. Expected fields precede OCR."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).parent / 'fixtures' / 'ocr-fields'
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'


def build():
    ROOT.mkdir(exist_ok=True)
    cases=[]
    def case(name,title,rows,paid=None,balance=None,refund=None,suggest=None,status='paid',layout='stack',variant='normal'):
        cases.append({'id':name,'title':title,'rows':rows,'layout':layout,'variant':variant,
                      'expected':{'payment_status':status,'actual_paid':paid,'account_balance':balance,'refund':refund,'suggested_expense_cents':suggest}})
    case('01_paid_balance','支付成功',['实际支付金额：128.50元','账户余额：9800.00元'],12850,980000,suggest=12850)
    case('02_balance_smaller','付款成功',['实付金额：1500.00元','账户余额：20.00元'],150000,2000,suggest=150000)
    case('03_refund','退款成功',['退款金额：128.50元','账户余额：9800.00元'],balance=980000,refund=12850,status='refund_related')
    case('04_partial_refund','部分退款',['原支付金额：500.00元','退款金额：100.00元','账户余额：900.00元'],balance=90000,refund=10000,status='refund_related')
    case('05_refund_pending','退款处理中',['原支付金额：300.00元','预计退款：80.00元'],refund=8000,status='refund_related')
    case('06_refund_failed','退款失败',['退款金额：88.00元'],refund=8800,status='refund_related')
    case('07_mixed_payment_refund','支付成功',['实付金额：100.00元','退款金额：20.00元','账户余额：1000.00元'],10000,100000,2000,status='refund_related')
    case('08_waiting','待付款',['支付金额：128.50元','账户余额：5000.00元'],12850,500000,status='unpaid')
    case('09_failed_payment','支付失败',['支付金额：80.00元','账户余额：900.00元'],8000,90000,status='unpaid')
    case('10_closed','交易关闭',['应付金额：50.00元','账户余额：900.00元'],balance=90000,status='unpaid')
    case('11_only_balance','支付成功',['账户余额：8000.00元'],balance=800000)
    case('12_only_unlabelled','交易详情',['¥ 80.00'],status='unknown')
    case('13_discount','支付成功',['原价：100.00元','优惠金额：10.00元','实际支付：90.00元','账户余额：900.00元'],9000,90000,suggest=9000)
    case('14_tax','支付成功',['实际支付金额：106.00元','税额：6.00元','账户余额：3000.00元'],10600,300000,suggest=10600)
    case('15_invoice','电子发票',['价税合计：106.00元','税额：6.00元','开票日期：2026-10-12'],status='invoice')
    case('16_incoming','收款成功',['到账金额：100.00元','账户余额：900.00元'],balance=90000,status='incoming')
    case('17_conflict','支付成功',['实际支付金额：100.00元','付款金额：90.00元','账户余额：2000.00元'],balance=200000)
    case('18_repeated','支付成功',['实际支付金额：100.00元','付款金额：100.00元'])
    case('19_one_cent','支付成功',['实付金额：0.01元','账户余额：100.00元'],1,10000,suggest=1)
    case('20_zero','支付成功',['实付金额：0.00元','账户余额：100.00元'],0,10000)
    case('21_fullwidth','支付成功',['实际支付金额：１２８．５０元','账户余额：９００．００元'],12850,90000,suggest=12850)
    case('22_grouped','支付成功',['实际支付金额：1,280.50元','账户余额：98,000.00元'],128050,9800000,suggest=128050)
    case('23_split_columns','支付成功',['实际支付金额：128.50元','账户余额：8000.00元'],12850,800000,suggest=12850,layout='columns')
    case('24_split_rows','支付成功',['实际支付金额：128.50元','账户余额：8000.00元'],12850,800000,suggest=12850,layout='split')
    case('25_unknown_status','付款详情',['实付金额：128.50元','账户余额：8000.00元'],12850,800000,status='unknown')
    case('26_foreign_currency','支付成功',['实付金额：128.50元','币种：美元'],12850)
    case('27_dark','支付成功',['实际支付金额：66.60元','账户余额：9900.00元'],6660,990000,suggest=6660,variant='dark')
    case('28_small','支付成功',['实际支付金额：66.60元','账户余额：9900.00元'],6660,990000,suggest=6660,variant='small')
    case('29_blur','支付成功',['实际支付金额：66.60元','账户余额：9900.00元'],6660,990000,suggest=6660,variant='blur')
    case('30_jpeg','退款成功',['原支付金额：120.00元','退款金额：40.00元','账户余额：1600.00元'],balance=160000,refund=4000,status='refund_related',variant='jpeg')
    for c in cases:
        dark=c['variant']=='dark'; bg='#18251f' if dark else '#ffffff'; fg='#ffffff' if dark else '#17251e'
        image=Image.new('RGB',(900,900),bg); draw=ImageDraw.Draw(image)
        texts,boxes=[],[]
        def text(value,x,y,size):
            font=ImageFont.truetype(FONT,size)
            draw.text((x,y),value,font=font,fill=fg)
            a,b,d,e=draw.textbbox((x,y),value,font=font)
            texts.append(value);boxes.append([[a,b],[d,b],[d,e],[a,e]])
        text('合成测试 · 非真实凭证',45,35,22)
        text(c['title'],45,100,38)
        y=205
        for row in c['rows']:
            if c['layout']=='columns' and '：' in row:
                label,value=row.split('：',1);text(label,45,y,30);text(value,590,y,30);y+=95
            elif c['layout']=='split' and '：' in row:
                label,value=row.split('：',1);text(label,45,y,30);text(value,45,y+50,32);y+=150
            else:
                text(row,45,y,32);y+=95
        if c['variant']=='small': image=image.resize((540,540))
        if c['variant']=='blur': image=image.filter(ImageFilter.GaussianBlur(1.2))
        suffix='.jpg' if c['variant']=='jpeg' else '.png'
        c['file']=c['id']+suffix
        image.save(ROOT/c['file'],**({'quality':45} if suffix=='.jpg' else {}))
        c['ideal_ocr']={'texts':texts,'boxes':boxes,'scores':[.99]*len(texts)}
    (ROOT/'manifest.json').write_text(json.dumps({'source':'synthetic, expectations authored before OCR; no real-screenshot accuracy claim','cases':cases},ensure_ascii=False,indent=2)+'\n')
    print(f'Generated {len(cases)} labelled synthetic images: {ROOT}')

if __name__=='__main__': build()
