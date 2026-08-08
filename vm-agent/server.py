#!/usr/bin/env python3
import os, subprocess, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN=os.environ.get('VM_AGENT_TOKEN','')
PORT=int(os.environ.get('VM_AGENT_PORT','8799'))

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data=json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.headers.get('Authorization','') != 'Bearer '+TOKEN: return self._send(401, {'error':'unauthorized'})
        if self.path == '/health': return self._send(200, {'ok':True})
        return self._send(404, {'error':'not_found'})
    def do_POST(self):
        if self.headers.get('Authorization','') != 'Bearer '+TOKEN: return self._send(401, {'error':'unauthorized'})
        if self.path != '/exec': return self._send(404, {'error':'not_found'})
        n=int(self.headers.get('Content-Length','0')); body=json.loads(self.rfile.read(n) or b'{}')
        cmd=body.get('command')
        if not isinstance(cmd,str) or not cmd.strip(): return self._send(400, {'error':'command_required'})
        if len(cmd)>12000: return self._send(400, {'error':'command_too_long'})
        try:
            p=subprocess.run(['/bin/bash','-lc',cmd],capture_output=True,text=True,timeout=min(int(body.get('timeout',120)),300))
            return self._send(200, {'ok':p.returncode==0,'code':p.returncode,'stdout':p.stdout[-50000:],'stderr':p.stderr[-50000:]})
        except subprocess.TimeoutExpired as e:
            return self._send(408, {'ok':False,'error':'timeout','stdout':(e.stdout or '')[-50000:] if isinstance(e.stdout,str) else ''})
        except Exception as e:
            return self._send(500, {'error':str(e)})
    def log_message(self,*args): pass

ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
