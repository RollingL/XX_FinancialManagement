"""Conservative outgoing WeChat bill fields; generic amounts keep their existing rules."""
import re
import unicodedata
from datetime import date
from ocr_fields import MIN_SCORE, parse_money, FOREIGN, UNPAID, INCOMING


def expense_fields(texts, boxes, scores, extraction):
    result = {'amount_cents': extraction['suggested_expense_cents'], 'date': None, 'merchant': None}
    blocks = []
    for text, box, score in zip(texts, boxes, scores):
        xs, ys = zip(*box)
        blocks.append({'text': unicodedata.normalize('NFKC', text).strip(), 'score': score,
                       'x': min(xs), 'y': min(ys), 'right': max(xs), 'bottom': max(ys)})
    joined = '\n'.join(b['text'] for b in blocks)
    # Refunds, incoming transfers and failed payments never become a new outgoing expense.
    if FOREIGN.search(joined) or UNPAID.search(joined) or INCOMING.search(joined) or re.search('退款|退回|已退', joined):
        return {'amount_cents': None, 'date': None, 'merchant': None}
    titles = [b for b in blocks if b['text'] == '账单' and b['score'] >= MIN_SCORE]
    if titles:
        result['amount_cents'] = None
    outgoing = [b for b in blocks if re.fullmatch(r'[-−]\s*\d+\.\d{2}', b['text'])]
    status = [b for b in blocks if b['text'] in ('支付成功', '对方已收钱') and b['score'] >= MIN_SCORE]
    bill = len(titles) == len(outgoing) == len(status) == 1
    if bill:
        title, amount, paid = titles[0], outgoing[0], status[0]
        bill = title['bottom'] < amount['y'] < amount['bottom'] < paid['y'] and amount['score'] >= MIN_SCORE
    if bill:
        result['amount_cents'] = parse_money(amount['text'][1:].strip()) or None
        candidates = [b for b in blocks if title['bottom'] < b['y'] and b['bottom'] < amount['y']]
        candidates.sort(key=lambda b: b['bottom'], reverse=True)
        if candidates:
            merchant = candidates[0]
            height = amount['bottom'] - amount['y']
            if (merchant['score'] >= MIN_SCORE and 1 <= len(merchant['text']) <= 100
                    and amount['y'] - merchant['bottom'] <= 2 * height
                    and abs((merchant['x'] + merchant['right'] - amount['x'] - amount['right']) / 2) < height
                    and not re.search(r'余额|退款|原价|优惠|金额|时间|状态', merchant['text'])):
                result['merchant'] = merchant['text']
    if not bill and extraction['payment_status'] != 'paid':
        return {'amount_cents': None, 'date': None, 'merchant': None}
    dates = []
    for block in blocks:
        match = re.fullmatch(r'(?:支付时间|付款时间|转账时间)[：:\s]*(.*)', block['text'])
        if not match:
            continue
        value, score = match[1], block['score']
        if not value:
            neighbors = [b for b in blocks if b['x'] >= block['right'] and
                         min(b['bottom'], block['bottom']) - max(b['y'], block['y']) >=
                         .5 * min(b['bottom'] - b['y'], block['bottom'] - block['y'])]
            neighbors.sort(key=lambda b: b['x'])
            if neighbors:
                value, score = neighbors[0]['text'], min(score, neighbors[0]['score'])
        parsed = re.fullmatch(r'(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?', value)
        try:
            dates.append(date(*map(int, parsed.groups())).isoformat() if parsed and score >= MIN_SCORE else None)
        except ValueError:
            dates.append(None)
    if len(dates) == 1:
        result['date'] = dates[0]
    return result
