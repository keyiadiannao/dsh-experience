"""
embed-server.py - tiny local embedding HTTP service for dsh-experience.

Loads a cached sentence-transformers model (multilingual MiniLM, ~470MB, on GPU
if available) and serves POST /embed {texts:[...]} -> {vectors:[[...],...]}.

Zero extra deps beyond transformers+torch (already present).  Run once and keep
it alive; the Node store calls it over HTTP, and falls back to lexical search
when this service is down.

Usage: python embed-server.py [port]   (default 8001)
"""
import json
import sys
import torch
from http.server import BaseHTTPRequestHandler, HTTPServer
from transformers import AutoTokenizer, AutoModel

MODEL_NAME = "BAAI/bge-large-zh-v1.5"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8001

# bge-large-zh is trained with an asymmetric query/doc instruction
QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章:"

print(f"[embed-server] loading {MODEL_NAME} ...", flush=True)
tok = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModel.from_pretrained(MODEL_NAME)
device = "cuda" if torch.cuda.is_available() else "cpu"
model = model.to(device)
model.eval()
print(f"[embed-server] ready on 127.0.0.1:{PORT} ({device})", flush=True)


def embed(texts):
    if not texts:
        return []
    t = tok(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
    t = {k: v.to(device) for k, v in t.items()}
    with torch.no_grad():
        out = model(**t)
    mask = t["attention_mask"].unsqueeze(-1).float()
    vec = (out.last_hidden_state * mask).sum(1) / mask.sum(1)
    vec = torch.nn.functional.normalize(vec, p=2, dim=1)
    return vec.cpu().numpy().tolist()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/embed":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if "texts" in body:
                    # pure docs (no query instruction) — for pairwise similarity
                    vecs = embed(body.get("texts", []))
                    resp = json.dumps({"vectors": vecs}, ensure_ascii=False)
                else:
                    # query + docs (query gets the bge instruction)
                    query_vec = embed([QUERY_INSTRUCTION + body.get("query", "")])[0]
                    doc_vecs = embed(body.get("docs", []))
                    resp = json.dumps({"query": query_vec, "docs": doc_vecs}, ensure_ascii=False)
                self.send_response(200)
            except Exception as e:
                resp = json.dumps({"error": str(e)})
                self.send_response(500)
            data = resp.encode("utf-8")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
