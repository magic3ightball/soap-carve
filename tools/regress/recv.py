# 회귀 검사 캡처 수신기 (로컬 전용): POST /<이름>/<장면> 의 dataURL PNG를 out/<이름>/<장면>.png 로 저장
import http.server, base64, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')

class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST')
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        parts = [p for p in self.path.split('/') if p and p not in ('.', '..')]
        if len(parts) != 2:
            self.send_response(400); self._cors(); self.end_headers(); return
        body = self.rfile.read(int(self.headers['Content-Length'])).decode()
        d = os.path.join(OUT, parts[0]); os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, parts[1] + '.png'), 'wb') as f:
            f.write(base64.b64decode(body.split(',', 1)[1]))
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', 8941), H).serve_forever()
