// Fase 2 — Cliente thin REST para Upstash Redis (sem dependências Node)
// Funciona em Cloudflare Workers (usa fetch nativo)
export class UpstashRedis {
  private url: string; private token: string; private timeoutMs: number;
  constructor(env: any) {
    const url = String(env.UPSTASH_REDIS_REST_URL || '').trim();
    const token = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
    if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN em falta');
    this.url = url.replace(/\/+$/, ''); this.token = token; this.timeoutMs = Number(env.REDIS_TIMEOUT_MS || 4000);
  }
  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(this.url + path, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`upstash http ${res.status}`);
    return res.json();
  }
  async cmd(...args: (string | number)[]): Promise<any> { const r = await this.post('', args); if (r?.error) throw new Error(String(r.error)); return r?.result; }
  async pipeline(cmds: (string | number)[][]): Promise<any[]> { const r = await this.post('/pipeline', cmds); if (!Array.isArray(r)) throw new Error('upstash: pipeline invalid'); return r.map((x: any) => { if (x?.error) throw new Error(String(x.error)); return x?.result; }); }
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<any> { const r = await this.post('', ['EVAL', script, String(keys.length), ...keys, ...args]); if (r?.error) throw new Error(String(r.error)); return r?.result; }
  geoadd(key: string, lng: number, lat: number, member: string) { return this.cmd('GEOADD', key, lng, lat, member); }
  georadius(key: string, lng: number, lat: number, km: number, count: number) { return this.cmd('GEORADIUS', key, lng, lat, km, 'km', 'WITHDIST', 'WITHCOORD', 'COUNT', count, 'ASC'); }
}
