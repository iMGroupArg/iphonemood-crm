#!/usr/bin/env python3
"""Servidor SOLO PARA DESARROLLO: muestra el CRM real en /preview.html con una base de datos falsa
(sesión iniciada y datos de ejemplo), para ver y probar el celular sin iniciar sesión ni tocar Supabase.

    python3 tests/preview-movil/servir.py 4410      →   http://localhost:4410/preview.html

Es el crm.html de verdad (mismo menú, mismos módulos, mismo CSS): sólo se cambian dos cosas al servirlo,
la librería de Supabase (por tests/preview-movil/fake-supabase.js) y config.js (por una configuración vacía).
No se escribe nada en el repositorio y nada sale a internet salvo las librerías de gráficos que ya usa el CRM.
"""
import http.server, os, re, sys

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PUERTO = int(sys.argv[1]) if len(sys.argv) > 1 else 4410

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=RAIZ, **k)
    def do_GET(self):
        if self.path.split('?')[0] in ('/preview.html', '/'):
            html = open(os.path.join(RAIZ, 'crm.html'), encoding='utf-8').read()
            html = re.sub(r'<script src="https://cdn\.jsdelivr\.net/npm/@supabase/[^"]*"[^>]*></script>',
                          '<script src="/tests/preview-movil/fake-supabase.js"></script>', html)
            html = html.replace('<script src="config.js"></script>', '')
            html = re.sub(r'(src/modules/app\.js)\?v=\d+', r'\1', html)
            cuerpo = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(cuerpo)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers(); self.wfile.write(cuerpo); return
        return super().do_GET()
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass

if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', PUERTO), H).serve_forever()
