"""Run fixed synthetic fixtures through the real offline OCR and amount parser."""
import hashlib
import json
from pathlib import Path
import platform
import sys
import time
from ocr_probe import create_engine, recognize
from ocr_fields import extract_fields


def validate():
    root=Path(__file__).parent
    fixture=root/'fixtures'/'ocr-fields'
    manifest_path=fixture/'manifest.json'
    manifest=json.loads(manifest_path.read_text())
    output=root.parent/'evidence'/'stage0'/'ocr-fields-2026-10-12'
    output.mkdir(exist_ok=True)
    engine,models=create_engine()
    rows=[]
    def observed(extraction):
        return {'payment_status':extraction['payment_status'], **{k:extraction['fields'][k] for k in ['actual_paid','account_balance','refund']}, 'suggested_expense_cents':extraction['suggested_expense_cents']}
    for case in manifest['cases']:
        ideal=extract_fields(**case['ideal_ocr'])
        if observed(ideal)!=case['expected']:
            raise AssertionError(f"Invalid fixture/parser contract {case['id']}: {observed(ideal)} != {case['expected']}")
        started=time.perf_counter()
        result=recognize(engine,fixture/case['file'])
        actual=observed(result['extraction'])
        differences={k:{'expected':v,'actual':actual[k]} for k,v in case['expected'].items() if actual[k]!=v}
        row={'id':case['id'],'image':case['file'],'image_sha256':hashlib.sha256((fixture/case['file']).read_bytes()).hexdigest(), 'expected':case['expected'],'actual':actual,'exact_match':not differences,'differences':differences,'unsafe_suggestion':actual['suggested_expense_cents'] is not None and actual['suggested_expense_cents']!=case['expected']['suggested_expense_cents'],'ocr':result,'wall_ms':round((time.perf_counter()-started)*1000)}
        rows.append(row)
        print(case['id'], 'PASS' if not differences else json.dumps(differences,ensure_ascii=False), flush=True)
        (output/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n')
    summary={'platform':platform.platform(),'python':sys.version,'source':manifest['source'],'manifest_sha256':hashlib.sha256(manifest_path.read_bytes()).hexdigest(),'models':{k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in models.items()},'cases':len(rows),'exact_matches':sum(r['exact_match'] for r in rows),'unsafe_suggestions':sum(r['unsafe_suggestion'] for r in rows),'abstentions_when_expected':sum(r['actual']['suggested_expense_cents'] is None and r['expected']['suggested_expense_cents'] is not None for r in rows),'positive_field_matches':{},'scope':'Mac synthetic screenshots; Windows and real redacted screenshots UNVERIFIED'}
    for key in ['actual_paid','account_balance','refund']:
        positives=[r for r in rows if r['expected'][key] is not None]
        summary['positive_field_matches'][key]={'matched':sum(r['actual'][key]==r['expected'][key] for r in positives),'expected_present':len(positives)}
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    return 0 if all(r['exact_match'] for r in rows) else 1

if __name__=='__main__': sys.exit(validate())
