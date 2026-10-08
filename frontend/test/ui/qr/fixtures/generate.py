"""Regenerates `python-qrcode.json`, the oracle the QR encoder is tested against.

Run with python-qrcode 8.2 (`pip install qrcode==8.2`):

    python3 generate.py > python-qrcode.json

Why python-qrcode: it is the generator whose mask choice reproduces a real manufacturer's
label module for module (see `label-20202021-3840.txt`). Nayuki's qrcodegen and segno pick
different masks for the same data, so "spec-correct" alone does not decide the pattern.

The payloads are deterministic pseudo-random Base-38 strings, not real onboarding payloads:
the encoder only cares about the character set, and lengths are chosen to cross version
boundaries, including version 7 and above, where the version-information blocks appear.
"""

import json
import random

import qrcode
from qrcode.util import QRData, MODE_ALPHA_NUM

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-."
LEVELS = {
    "L": qrcode.constants.ERROR_CORRECT_L,
    "M": qrcode.constants.ERROR_CORRECT_M,
    "Q": qrcode.constants.ERROR_CORRECT_Q,
    "H": qrcode.constants.ERROR_CORRECT_H,
}

rng = random.Random(20202021)
payloads = ["MT:Y.K9042C00KA0648G00"]
for length in (19, 19, 19, 30, 44, 60, 90, 130, 180, 252):
    payloads.append("MT:" + "".join(rng.choice(ALPHABET) for _ in range(length)))

cases = []
for payload in payloads:
    for name, level in LEVELS.items():
        qr = qrcode.QRCode(error_correction=level, border=0)
        qr.add_data(QRData(payload.encode("ascii"), mode=MODE_ALPHA_NUM))
        qr.make(fit=True)
        rows = ["".join("1" if dark else "0" for dark in row) for row in qr.get_matrix()]
        cases.append(
            {
                "payload": payload,
                "ecl": name,
                "version": qr.version,
                "mask": qr.mask_pattern if qr.mask_pattern is not None else qr.best_mask_pattern(),
                "rows": rows,
            }
        )

print(json.dumps(cases, indent=1))
