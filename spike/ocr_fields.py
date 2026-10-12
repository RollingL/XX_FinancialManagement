"""Conservative screenshot amount candidates. No ledger writes or inferred cash events."""
import math
import re
import unicodedata

MAX_CENTS = 2**53 - 1
MIN_SCORE = 0.90  # shortcut: fixed review threshold, calibrate on real redacted screenshots before production.
LABELS = {
    'original_paid': ['原支付金额', '原付款金额', '原实付金额'],
    'actual_paid': ['实际支付金额', '实际付款金额', '实际支付', '实际付款', '实付金额', '实付款', '实付', '支付金额', '付款金额'],
    'account_balance': ['支付后余额', '账户余额', '可用余额', '钱包余额', '余额'],
    'refund': ['实际退款金额', '已退金额', '退款金额', '退回金额', '本次退款', '预计退款', '申请退款金额'],
    'original_price': ['订单金额', '商品总额', '原价'],
    'discount': ['优惠金额', '优惠券', '已优惠', '优惠'],
    'tax': ['税额'],
    'invoice_total': ['价税合计', '票面金额'],
    'amount_due': ['待付金额', '应付金额', '待支付金额'],
}
ROLE = {label: role for role, labels in LABELS.items() for label in labels}
LABEL = re.compile('|'.join(re.escape(x) + ('(?!支付|宝支付)' if x == '余额' else '') for x in sorted(ROLE, key=len, reverse=True)))
MONEY = re.compile(r'[：:;；\s]*([+\-−]?)\s*(?:[¥￥]\s*|人民币\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(?:元|RMB|CNY)?[。;；\s]*', re.I)
PAID = re.compile(r'支付成功|付款成功|交易成功|已支付|已付款')
UNPAID = re.compile(r'待付款|待支付|未付款|未支付|支付失败|付款失败|交易关闭|订单关闭|取消支付|未完成|尚未|未成功|未到账')
INCOMING = re.compile(r'收款成功|已收款|收入金额|转入金额|到账金额')
FOREIGN = re.compile(r'美元|港币|港元|欧元|日元|USD|HKD|EUR|JPY|[$€£]', re.I)


def parse_money(text):
    """Reject bad separators, extra precision and signs; never repair OCR digits."""
    match = MONEY.fullmatch(unicodedata.normalize('NFKC', text))
    if not match or match[1]:
        return None
    whole, _, fraction = match[2].replace(',', '').partition('.')
    value = int(whole) * 100 + int(fraction.ljust(2, '0') or '0')
    return value if value <= MAX_CENTS else None


def extract_fields(texts, boxes=None, scores=None):
    if not isinstance(texts, (list, tuple)) or len(texts) > 500:
        raise ValueError('Expected at most 500 OCR text blocks')
    if any(not isinstance(t, str) or len(t) > 2000 for t in texts):
        raise ValueError('Invalid OCR text block')
    if boxes is not None and len(boxes) != len(texts):
        raise ValueError('OCR boxes/texts length mismatch')
    if scores is not None and len(scores) != len(texts):
        raise ValueError('OCR scores/texts length mismatch')
    blocks = []
    for i, raw in enumerate(texts):
        score = float(scores[i]) if scores is not None else 0.0
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError('Invalid OCR confidence')
        rect = None
        if boxes is not None:
            box = boxes[i]
            if len(box) != 4 or any(len(p) != 2 or any(not math.isfinite(float(v)) for v in p) for p in box):
                raise ValueError('Invalid OCR box')
            xs, ys = zip(*box)
            rect = [min(xs), min(ys), max(xs), max(ys)]
            if rect[2] <= rect[0] or rect[3] <= rect[1]:
                raise ValueError('Empty OCR box')
        blocks.append({'index': i, 'text': unicodedata.normalize('NFKC', raw).strip(), 'raw': raw, 'score': score, 'rect': rect})
    joined = '\n'.join(b['text'] for b in blocks)
    if '退款' in joined or '退回金额' in joined or '已退金额' in joined:
        status = 'refund_related'
    elif UNPAID.search(joined):
        status = 'unpaid'
    elif INCOMING.search(joined):
        status = 'incoming'
    elif '发票' in joined or '价税合计' in joined:
        status = 'invoice'
    elif any(PAID.search(b['text']) and b['score'] >= MIN_SCORE for b in blocks):
        status = 'paid'
    else:
        status = 'unknown'
    candidates, warnings = [], []
    used = set()

    def add(role, label, value, sources):
        confidence = min(b['score'] for b in sources)
        candidates.append({'role': role, 'label': label, 'amount_cents': value,
                           'ocr_confidence': confidence, 'needs_review': True,
                           'source_indices': [b['index'] for b in sources],
                           'source_texts': [b['raw'] for b in sources],
                           'source_boxes': [boxes[b['index']] for b in sources] if boxes is not None else []})
        used.update(b['index'] for b in sources)
        if confidence < MIN_SCORE:
            warnings.append('low_confidence')

    def neighbor(block):
        if block['rect'] is None:
            return None
        x1, y1, x2, y2 = block['rect']
        height = y2 - y1
        possible = []
        for other in blocks:
            if other['index'] == block['index'] or other['rect'] is None:
                continue
            a, b, c, d = other['rect']
            overlap = max(0, min(y2, d) - max(y1, b))
            same_row = a >= x2 and overlap >= 0.5 * min(height, d - b)
            below = 0 <= b - y2 <= 2.5 * height and (abs(a - x1) <= height or abs((a+c-x1-x2)/2) <= height)
            if same_row or below:
                # An intervening text block prevents hopping over a different label.
                distance = (a - x2) / height if same_row else 20 + (b - y2) / height
                possible.append((distance, other))
        possible.sort(key=lambda pair: pair[0])
        if not possible or (len(possible) > 1 and abs(possible[0][0] - possible[1][0]) < 0.25):
            return None
        other = possible[0][1]
        # A number already aligned with another amount label is not the status header's payment.
        a, b, c, d = other['rect']
        if any(label['index'] != block['index'] and label['rect'] is not None and LABEL.search(label['text'])
               and label['rect'][2] <= a and min(d, label['rect'][3]) - max(b, label['rect'][1]) >= .5 * (d-b)
               for label in blocks):
            return None
        return other if parse_money(other['text']) is not None else None

    for block in blocks:
        matches = list(LABEL.finditer(block['text']))
        for pos, match in enumerate(matches):
            end = matches[pos+1].start() if pos+1 < len(matches) else len(block['text'])
            tail = block['text'][match.end():end]
            value = parse_money(tail)
            sources = [block]
            if value is None and not tail.strip(' :：;；'):
                other = neighbor(block)
                if other:
                    value = parse_money(other['text'])
                    sources.append(other)
            if value is None:
                warnings.append('unresolved_amount_label')
            else:
                add(ROLE[match[0]], match[0], value, sources)
        if not matches and PAID.fullmatch(block['text']) and status == 'paid':
            other = neighbor(block)
            if other:
                add('actual_paid', block['text'], parse_money(other['text']), [block, other])
    for block in blocks:
        if block['index'] not in used and parse_money(block['text']) is not None:
            add('unknown', '', parse_money(block['text']), [block])
            warnings.append('unlabelled_amount')
    fields = {}
    for role in LABELS:
        found = [c for c in candidates if c['role'] == role]
        # Repeated amounts can be distinct transactions, even if their values agree.
        fields[role] = found[0]['amount_cents'] if len(found) == 1 and found[0]['ocr_confidence'] >= MIN_SCORE else None
        if len(found) > 1:
            warnings.append('multiple_' + role)
    if FOREIGN.search(joined):
        warnings.append('unsupported_currency')
    if status != 'paid':
        warnings.append('not_confirmed_payment')
    if fields['actual_paid'] is None:
        warnings.append('missing_actual_paid')
    if fields['actual_paid'] == 0:
        warnings.append('zero_payment')
    suggested = fields['actual_paid'] if status == 'paid' and fields['actual_paid'] and not warnings else None
    return {'payment_status': status, 'fields': fields, 'candidates': candidates,
            'suggested_expense_cents': suggested, 'requires_confirmation': True,
            'auto_bookkeeping': False, 'warnings': sorted(set(warnings)),
            'scope': 'stage0 amount candidates only; no refund netting, dates, invoice validation or ledger writes'}
