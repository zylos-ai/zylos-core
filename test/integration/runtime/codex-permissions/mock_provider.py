"""Loopback-only deterministic Responses fixture; no credentials or upstream requests."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import threading,json
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  msg={'id':'msg_probe','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'fixture ok','annotations':[]}]}
  response={'id':'resp_probe','object':'response','created_at':1,'status':'completed','model':'fixture','output':[msg],'usage':{'input_tokens':1,'output_tokens':2,'total_tokens':3}}
  events=[{'type':'response.created','response':dict(response,status='in_progress',output=[])},{'type':'response.output_item.added','output_index':0,'item':dict(msg,status='in_progress',content=[])},{'type':'response.content_part.added','item_id':'msg_probe','output_index':0,'content_index':0,'part':{'type':'output_text','text':'','annotations':[]}},{'type':'response.output_text.delta','item_id':'msg_probe','output_index':0,'content_index':0,'delta':'fixture ok'},{'type':'response.output_text.done','item_id':'msg_probe','output_index':0,'content_index':0,'text':'fixture ok'},{'type':'response.output_item.done','output_index':0,'item':msg},{'type':'response.completed','response':response}]
  body=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
def start():
 s=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=s.serve_forever,daemon=True).start()
 cfg=f'\nmodel = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nbase_url = "http://127.0.0.1:{s.server_port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n'
 return s,cfg
