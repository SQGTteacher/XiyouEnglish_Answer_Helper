// 西柚英语 · 在线接口（桌面端）
// 直接复刻学生端 4.8.6 的请求签名，账号密码登录后取作业与答案。
'use strict';
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const querystring = require('querystring');

const HOST = 'app.xiyouyingyu.com';
const MASTER = '_Sts100#@';
const RELEASE = '4.8.6';
const DEVICE = 'web-pc';
const BRAND = '1.7976931348623157e+308';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36';
const OS_VERSION =
  '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Safari/537.36';

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

/** 与前端 objSort + md5(str + masters) 完全一致 */
function signParams(params) {
  const keys = Object.keys(params).sort();
  let raw = '';
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) raw += '&';
    raw += keys[i] + '=' + params[keys[i]];
  }
  return md5(raw + MASTER);
}

class XiyouApi {
  constructor(udid) {
    this.udid = udid || crypto.randomBytes(16).toString('hex');
    this.sessionId = '';
    this.userId = '';
    this.clazzId = '';
    this.lastError = '';
  }

  common() {
    const h = {
      appVersion: '4.8.6',
      belong: '1',
      device: DEVICE,
      osVersion: OS_VERSION,
      release: RELEASE,
      brand: BRAND,
      timestamp: String(Date.now()),
    };
    if (this.sessionId) {
      h.sessionId = this.sessionId;
      h.userId = this.userId;
    }
    return h;
  }

  request(path, data, asJson) {
    const all = Object.assign(this.common(), data || {});
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip',
      release: RELEASE,
      device: DEVICE,
      udid: this.udid,
      sign: signParams(all),
      Origin: 'https://student.xiyouyingyu.com',
      Referer: 'https://student.xiyouyingyu.com/',
    };
    let body;
    if (asJson) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      body = JSON.stringify(all);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      body = querystring.stringify(all);
    }
    const buf = Buffer.from(body, 'utf8');
    headers['Content-Length'] = buf.length;

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: HOST,
          path,
          method: 'POST',
          headers,
          timeout: 25000,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];
          let stream = res;
          if ((res.headers['content-encoding'] || '').includes('gzip')) {
            stream = res.pipe(zlib.createGunzip());
          }
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch (e) {
              reject(new Error('服务器返回格式异常：' + text.slice(0, 120)));
              return;
            }
            resolve(json);
          });
          stream.on('error', reject);
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('连接服务器超时'));
      });
      req.on('error', (e) => {
        const msg = String(e.message || e);
        if (/ENOTFOUND|EAI_AGAIN/.test(msg)) reject(new Error('无法解析服务器域名，请检查网络'));
        else if (/certificate|SSL|TLS/i.test(msg)) reject(new Error('与服务器的安全连接失败：' + msg));
        else reject(new Error('网络请求失败：' + msg));
      });
      req.write(buf);
      req.end();
    });
  }

  static isOk(resp) {
    return resp && String(resp.state) === '11';
  }

  async login(account, password) {
    const resp = await this.request('/user/login/account', { loginAccount: account, password }, false);
    if (XiyouApi.isOk(resp)) {
      const d = resp.data || {};
      const info = d.userInfo || d;
      this.sessionId = info.sessionId || '';
      this.userId = info.id != null ? String(info.id) : '';
      this.clazzId = info.clazzId != null ? String(info.clazzId) : '';
    }
    return resp;
  }

  async homeworks() {
    if (this.userId && this.clazzId) {
      const merged = [];
      const seen = new Set();
      let okAny = false;
      // 实测 homeworkStatus=1 是当前待完成，0 为今日任务；两个都拉，按 id 去重
      for (const st of [1, 0]) {
        try {
          const r = await this.request(
            '/homework/findBagListV2',
            { userId: this.userId, clazzId: this.clazzId, homeworkStatus: st },
            true,
          );
          if (XiyouApi.isOk(r)) {
            okAny = true;
            const list = (r.data && r.data.bagList) || [];
            for (const b of list) {
              const k = String(b.id || b.name);
              if (seen.has(k)) continue;
              seen.add(k);
              merged.push(b);
            }
          } else {
            this.lastError = r.note || ('state=' + r.state);
          }
        } catch (e) {
          this.lastError = e.message;
        }
      }
      if (okAny) return { state: '11', data: { bagList: merged } };
    }
    try {
      return await this.request('/homework/findList', { pageIndex: '1', pageSize: '50' }, false);
    } catch (e) {
      throw e;
    }
  }

  async bagItems(bagId) {
    return this.request('/homework/findListByBagIdV2', { bagId }, true);
  }

  async paper(groupId) {
    return this.request('/paper/module/detail', { groupId }, false);
  }
}

module.exports = { XiyouApi, signParams, md5, UA };

