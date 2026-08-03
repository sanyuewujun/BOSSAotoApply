// ==UserScript==
// @name         BOSS直聘自动投递助手 (AI版 v4.6)
// @namespace    https://github.com/sanyuewujun/BOSSAotoApply
// @version      4.6
// @description  DOM提取 + 会话持久化，聊天页自动返回并继续投递
// @author       AI Assistant
// @match        https://www.zhipin.com/web/geek/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.siliconflow.cn
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 模板（默认值，可前台自定义） ====================
  const DEFAULT_TEMPLATES = [
    `如：您好！看到 {company} 的 {title} 岗位，期待沟通！`,
    `如：您好！我对 {title} 感兴趣，可以交流...`,
  ];

  const SESSION_KEY = 'bap_session';
  const GREETING_KEY = 'bap_custom_greeting';
  const DAILY_LIMIT_KEY = 'bap_daily_limit';
  const INTERVAL_KEY = 'bap_interval_sec';
  const MODEL_KEY = 'bap_model';
  const MODELS_KEY = 'bap_models'; // 实时获取的模型列表缓存
  const TEMPLATES_KEY = 'bap_templates';
  const SKILL_KEY = 'bap_skill';
  const FRESH_MS = 15 * 60 * 1000; // 会话 15 分钟内有效

  // 默认模型列表（仅作占位，面板可通过"刷新列表"从硅基流动 API 实时获取）
  const DEFAULT_MODELS = [
    'THUDM/GLM-4-9B-0414', 'Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1',
  ];

  // ==================== 状态 ====================
  let running = false, stopRequested = false, apiKey = '';

  function todayKey() { const d = new Date(); return `${d.getFullYear()}_${d.getMonth()+1}_${d.getDate()}`; }
  function getApplied() { return JSON.parse(GM_getValue('bap_applied_' + todayKey(), '[]')); }
  function getTodayCount() { return getApplied().length; }
  function isApplied(id) { return getApplied().some(j => j.id === id); }
  function markApplied(id, title, company) {
    const arr = getApplied();
    if (!arr.some(j => j.id === id)) { arr.push({ id, title, company, time: Date.now() }); GM_setValue('bap_applied_' + todayKey(), JSON.stringify(arr)); }
  }
  function getSkipped() { return JSON.parse(GM_getValue('bap_skip_' + todayKey(), '[]')); }
  function isSkipped(id) { return getSkipped().includes(id); }
  function addSkip(id) { if (!id) return; const arr = getSkipped(); if (!arr.includes(id)) { arr.push(id); GM_setValue('bap_skip_' + todayKey(), JSON.stringify(arr)); } }

  // ==================== 会话（跨页面） ====================
  function getSession() { try { return JSON.parse(GM_getValue(SESSION_KEY, 'null')); } catch (e) { return null; } }
  function setSession(s) { GM_setValue(SESSION_KEY, JSON.stringify(s)); }
  function clearSession() { GM_setValue(SESSION_KEY, 'null'); }
  function isChatPage() { return location.pathname.includes('/chat'); }
  function isJobsPage() { return location.pathname.includes('/jobs'); }

  // ==================== 可配置参数（弹窗设置，持久化） ====================
  function getDailyLimit() {
    const v = parseInt(GM_getValue(DAILY_LIMIT_KEY, '30'), 10);
    return (v > 0 && v <= 200) ? v : 30;
  }
  function getIntervalSec() {
    const v = parseInt(GM_getValue(INTERVAL_KEY, '30'), 10);
    return (v >= 5 && v <= 600) ? v : 30;
  }
  function getModel() { return GM_getValue(MODEL_KEY, '') || 'THUDM/GLM-4-9B-0414'; }

  // ==================== 模型列表（实时获取，不写死） ====================
  function getModels() {
    try {
      const saved = JSON.parse(GM_getValue(MODELS_KEY, 'null'));
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (e) {}
    return DEFAULT_MODELS.slice(); // 无缓存 → 占位默认
  }
  function renderModelSelect(filter = '') {
    const sel = document.getElementById('bap-model');
    if (!sel) return;
    const current = getModel();
    const kw = filter.toLowerCase().trim();
    const list = getModels().filter(m => !kw || m.toLowerCase().includes(kw));
    sel.innerHTML = list.map(m => `<option value="${m}" ${current === m ? 'selected' : ''}>${m}</option>`).join('');
    sel.size = Math.min(8, Math.max(4, list.length)); // 模型多时可滚动
  }
  // 从硅基流动 API 实时拉取模型列表（只保留文本生成模型）
  function refreshModels() {
    const key = apiKey || GM_getValue('siliconflow_api_key', '');
    if (!key) { log('⚠️ 未配置API Key，无法获取模型列表'); return; }
    log('🔄 正在获取模型列表...');
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'https://api.siliconflow.cn/v1/models',
      headers: { 'Authorization': `Bearer ${key}` },
      timeout: 15000,
      onload: r => {
        try {
          const d = JSON.parse(r.responseText);
          const arr = (d.data || []).filter(m => m.type === 'text' || m.type === undefined)
            .map(m => m.id).filter(Boolean);
          if (!arr.length) throw new Error('列表为空');
          GM_setValue(MODELS_KEY, JSON.stringify(arr));
          renderModelSelect('');
          const cur = getModel();
          log(`✅ 获取到 ${arr.length} 个模型${cur ? '（当前: ' + cur + '）' : ''}`);
        } catch (e) { log('❌ 获取模型失败：' + e.message); }
      },
      onerror: () => log('❌ 网络错误，获取模型失败'),
      ontimeout: () => log('❌ 请求超时，获取模型失败'),
    });
  }

  // ==================== 模板（前台自定义，持久化） ====================
  function getTemplates() {
    const saved = GM_getValue(TEMPLATES_KEY, '');
    if (saved && saved.trim()) {
      const arr = saved.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
      if (arr.length) return arr;
    }
    return DEFAULT_TEMPLATES.slice(); // 未配置或全空 → 用默认
  }
  function fillTemplate(title, company) {
    const tpls = getTemplates();
    return (tpls[0] || DEFAULT_TEMPLATES[0]).replace('{title}', title || '该岗位').replace('{company}', company || '贵司');
  }
  // 技能列表（前台配置，持久化；AI 生成时只允许使用这里的技能）
  function getSkill() { return GM_getValue(SKILL_KEY, '').trim(); }

  // ==================== AI ====================
  function callAI(template, jobTitle, jobCompany, jd) {
    return new Promise((resolve) => {
      const key = apiKey || GM_getValue('siliconflow_api_key', ''); // 仅用前台配置的 Key，不写死
      if (!key) { resolve(null); return; } // 未配置 → 调用方回落模板
      const skill = getSkill();
      const sysMsg = skill
        ? `你是求职助手，根据岗位信息生成一句打招呼语。硬性要求：1) 只能使用以下【技能列表】中真实掌握的技能来描述自己，严禁编造、夸大或补充列表之外的技能；2) 写作风格参考用户给的【模板】；3) 第一人称，120字以内；4) 直接输出内容，不要任何解释。\n技能列表：${skill}`
        : `你是求职助手，根据岗位信息生成一句打招呼语。硬性要求：1) 描述自己的技能时，只能使用模板中已有的技能表述，严禁编造、夸大技能；2) 写作风格参考用户给的【模板】；3) 第一人称，120字以内；4) 直接输出内容，不要任何解释。`;
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.siliconflow.cn/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        data: JSON.stringify({
          model: getModel(),
          messages: [
            { role: 'system', content: sysMsg },
            { role: 'user', content: `模板：${template}\n岗位：${jobTitle}\n公司：${jobCompany}\nJD：${(jd || '').substring(0, 300)}` }
          ],
          temperature: 0.7, max_tokens: 250,
        }),
        timeout: 15000,
        onload: r => { try { const d = JSON.parse(r.responseText); resolve(d.choices?.[0]?.message?.content?.trim() || null); } catch (e) { resolve(null); } },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    });
  }

  // ==================== UI ====================
  function setRunningUI(on) {
    const s = document.getElementById('bap-start'), t = document.getElementById('bap-stop');
    if (s) s.style.display = on ? 'none' : 'block';
    if (t) t.style.display = on ? 'block' : 'none';
  }

  function createPanel() {
    if (document.getElementById('boss-auto-apply-panel')) return;
    const savedKey = GM_getValue('siliconflow_api_key', ''); // 仅读取前台保存的 Key
    const savedGreeting = GM_getValue(GREETING_KEY, '');
    const savedModel = getModel();
    const savedTemplates = getTemplates().join('\n---\n'); // 前台模板文本（含默认值）
    const savedSkill = getSkill();
    apiKey = savedKey;

    const tabBtn = (id, label) => `<button id="${id}" class="bap-tab" style="flex:1;padding:4px;border:1px solid #d5d9de;border-radius:4px;background:#f5f6f8;color:#333;cursor:pointer;font-size:11px;">${label}</button>`;
    const modelOptions = getModels().map(m => `<option value="${m}" ${savedModel === m ? 'selected' : ''}>${m}</option>`).join('');

    const panel = document.createElement('div');
    panel.id = 'boss-auto-apply-panel';
    panel.innerHTML = `
      <div id="bap-top" style="background:#2c3e50;color:#fff;padding:8px 12px;border-radius:8px 8px 0 0;font-weight:bold;display:flex;justify-content:space-between;cursor:pointer;">
        <span>🤖 AI投递 v4.6</span><span>−</span>
      </div>
      <div id="bap-body" style="background:#fff;padding:10px;border:1px solid #2c3e50;border-top:none;border-radius:0 0 8px 8px;">
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          ${tabBtn('bap-tab-main', '⚙️ 投递配置')}
          ${tabBtn('bap-tab-ai', '🤖 AI配置')}
        </div>
        <div id="bap-view-main">
          <div style="font-size:11px;color:#666;margin-bottom:4px;">今日: <b id="bap-count">${getTodayCount()}</b>/${getDailyLimit()}
            <label style="float:right;"><input type="checkbox" id="bap-ai" checked> AI</label>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:4px;font-size:10px;color:#666;">
            <label style="flex:1;">每日上限 <input id="bap-limit" type="number" min="1" max="200" value="${getDailyLimit()}" style="width:52px;font-size:10px;padding:2px;"></label>
            <label style="flex:1;">间隔(s) <input id="bap-interval" type="number" min="5" max="600" value="${getIntervalSec()}" style="width:52px;font-size:10px;padding:2px;"></label>
          </div>
          <textarea id="bap-greeting" rows="2" placeholder="自定义招呼语（留空则用AI/模板；支持 {title} {company}）" style="width:100%;font-size:11px;padding:4px;margin-bottom:6px;box-sizing:border-box;resize:vertical;">${savedGreeting.replace(/</g, '&lt;')}</textarea>
        </div>
        <div id="bap-view-ai" style="display:none;">
          <div style="font-size:10px;color:#666;margin-bottom:3px;">硅基流动 API Key（<a href="https://cloud.siliconflow.cn/account/ak" target="_blank" style="color:#2c7be5;">cloud.siliconflow.cn</a> 注册获取；不填则用模板招呼语）</div>
          <input id="bap-key" type="password" placeholder="sk-...（仅需配置一次，自动保存）" value="${savedKey}" style="width:100%;font-size:10px;padding:3px;margin-bottom:6px;box-sizing:border-box;">
          <div style="font-size:10px;color:#666;margin-bottom:3px;">模型选择（招呼语由该模型生成）
            <button id="bap-refresh-models" style="float:right;font-size:9px;padding:1px 6px;border:1px solid #d5d9de;border-radius:3px;background:#f5f6f8;cursor:pointer;">🔄 刷新列表</button>
          </div>
          <input id="bap-model-filter" placeholder="过滤模型关键词，如 Qwen / DeepSeek" style="width:100%;font-size:10px;padding:2px;margin-bottom:3px;box-sizing:border-box;">
          <select id="bap-model" size="5" style="width:100%;font-size:10px;padding:2px;margin-bottom:8px;box-sizing:border-box;">${modelOptions}</select>
          <div style="font-size:10px;color:#666;margin-bottom:3px;">招呼语模板（多条用 <b>---</b> 分隔；支持 {title} {company} 变量；清空恢复默认）</div>
          <textarea id="bap-templates" rows="4" style="width:100%;font-size:10px;padding:4px;margin-bottom:8px;box-sizing:border-box;resize:vertical;" placeholder="如：您好！看到 {company} 的 {title} 岗位，期待沟通！\n\n---\n\n如：您好！我对 {title} 感兴趣，可以交流..."></textarea>
          <div style="font-size:10px;color:#666;margin-bottom:3px;">我的技能（逗号分隔；<b>AI 只允许用这里的技能，严禁编造</b>；留空则用模板中的技能）</div>
          <textarea id="bap-skill" rows="2" placeholder="如：Python, RAG, LangGraph, Dify, MCP协议, 通义千问API" style="width:100%;font-size:10px;padding:4px;margin-bottom:8px;box-sizing:border-box;resize:vertical;">${savedSkill.replace(/</g, '&lt;')}</textarea>
          <div style="font-size:10px;color:#777;background:#f7f8fa;border:1px solid #e6e8eb;border-radius:4px;padding:6px;line-height:1.6;">
            <b style="color:#444;">💰 费用参考</b>（每次投递约消耗 500~700 tokens）<br>
            · GLM-4-9B：免费（有限速），<b>≈ 无限次/元</b><br>
            · Qwen2.5-7B：≈ 0.00025 元/次，<b>约 4000 次/元</b><br>
            · Qwen2.5-14B：≈ 0.0009 元/次，约 1100 次/元<br>
            · DeepSeek-V3：≈ 0.0016 元/次，约 600 次/元<br>
            · DeepSeek-R1：≈ 0.005 元/次，约 200 次/元<br>
            <span style="color:#aaa;">注：按输入+输出 token 量计费，价格以硅基流动官网为准；30 次/日 × 每月 ≈ 900 次，用 7B 模型不到 1 元。</span>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button id="bap-start" style="flex:1;padding:6px;background:#27ae60;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">▶ 开始</button>
          <button id="bap-stop" style="flex:1;padding:6px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;display:none;">⏹ 停止</button>
        </div>
        <div id="bap-log" style="margin-top:6px;max-height:120px;overflow-y:auto;font-size:10px;color:#555;border-top:1px solid #eee;padding-top:4px;"></div>
      </div>`;
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;width:290px;z-index:99999;font-family:"Microsoft YaHei",Arial,sans-serif;';
    document.body.appendChild(panel);

    document.getElementById('bap-top').onclick = () => {
      const b = document.getElementById('bap-body');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
      document.getElementById('bap-top').querySelector('span:last-child').textContent = b.style.display === 'none' ? '+' : '−';
    };
    // 标签页切换
    const switchTab = (ai) => {
      document.getElementById('bap-view-main').style.display = ai ? 'none' : 'block';
      document.getElementById('bap-view-ai').style.display = ai ? 'block' : 'none';
      const active = ai ? 'bap-tab-ai' : 'bap-tab-main';
      const inactive = ai ? 'bap-tab-main' : 'bap-tab-ai';
      const a = document.getElementById(active), i = document.getElementById(inactive);
      a.style.background = '#2c7be5'; a.style.color = '#fff';
      i.style.background = '#f5f6f8'; i.style.color = '#333';
    };
    document.getElementById('bap-tab-main').onclick = () => switchTab(false);
    document.getElementById('bap-tab-ai').onclick = () => switchTab(true);
    document.getElementById('bap-key').onchange = e => { GM_setValue('siliconflow_api_key', e.target.value.trim()); apiKey = e.target.value.trim(); };
    document.getElementById('bap-model').onchange = e => GM_setValue(MODEL_KEY, e.target.value);
    document.getElementById('bap-refresh-models').onclick = refreshModels; // 实时获取模型列表
    document.getElementById('bap-model-filter').oninput = e => renderModelSelect(e.target.value); // 过滤模型
    document.getElementById('bap-templates').oninput = e => GM_setValue(TEMPLATES_KEY, e.target.value); // 模板实时持久化
    document.getElementById('bap-skill').oninput = e => GM_setValue(SKILL_KEY, e.target.value); // 技能实时持久化
    document.getElementById('bap-limit').onchange = e => {
      let v = parseInt(e.target.value, 10) || 30; v = Math.max(1, Math.min(200, v));
      e.target.value = v; GM_setValue(DAILY_LIMIT_KEY, String(v));
    };
    document.getElementById('bap-interval').onchange = e => {
      let v = parseInt(e.target.value, 10) || 30; v = Math.max(5, Math.min(600, v));
      e.target.value = v; GM_setValue(INTERVAL_KEY, String(v));
    };
    document.getElementById('bap-greeting').oninput = e => GM_setValue(GREETING_KEY, e.target.value); // 实时持久化，刷新不丢
    document.getElementById('bap-start').onclick = () => {
      if (!isJobsPage()) { log('⚠️ 请在职位列表页开始'); return; }
      running = true; stopRequested = false;
      setSession({ running: true, jobsUrl: location.href, ts: Date.now() });
      setRunningUI(true);
      resumeLoop();
    };
    document.getElementById('bap-stop').onclick = () => {
      stopRequested = true; running = false;
      clearSession();
      setRunningUI(false);
      log('⏹ 已停止');
    };
  }

  function log(msg) {
    const el = document.getElementById('bap-log'); if (!el) return;
    el.innerHTML += `<div>${new Date().toLocaleTimeString()} ${msg}</div>`;
    el.scrollTop = el.scrollHeight;
  }
  function updateCount() { const el = document.getElementById('bap-count'); if (el) el.textContent = getTodayCount(); }

  // ==================== DOM 工具 ====================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function getCards() { return document.querySelectorAll('li.job-card-box, li[class*="job-card"]'); }

  // 等待职位卡片渲染（SPA 加载需要时间）
  async function waitForCards(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const cards = getCards();
      if (cards.length) return cards;
      await sleep(800);
    }
    return null;
  }

  function getJobId(card) {
    const a = card && card.querySelector('a[href*="/job_detail/"]');
    if (a) { const m = a.href.match(/job_detail\/([\w.]+)/); if (m) return m[1].replace(/\.html$/, ''); }
    const btn = document.querySelector('.job-detail-op .op-btn-chat, .op-btn-chat');
    const m2 = btn && btn.getAttribute('ka') ? btn.getAttribute('ka').match(/chat_(\w+)/) : null;
    return m2 ? m2[1] : '';
  }

  function getJobInfoFromPage(card) {
    const d = document.querySelector('.job-detail-box, .job-detail');
    const title = (d?.querySelector('.job-name, .job-title, .job-detail-title')?.textContent || card?.querySelector('.job-name, .job-title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const salary = (d?.querySelector('.job-salary, .salary')?.textContent || card?.querySelector('.job-salary, .salary')?.textContent || '').replace(/\s+/g, ' ').trim();
    const company = (d?.querySelector('.company-name, .job-detail-company, .boss-name')?.textContent || card?.querySelector('.company-name, .company-link, .boss-name')?.textContent || '').replace(/\s+/g, ' ').trim();
    const jd = (d?.querySelector('.job-sec-text, .desc, .job-detail-body')?.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 500);
    return { title, salary, company, jd, jobId: getJobId(card) };
  }

  function findGreetButton() {
    const btn = document.querySelector('.job-detail-op a.op-btn-chat, .job-detail-box a.op-btn-chat, a.op-btn-chat');
    if (btn && btn.offsetParent && (btn.textContent.includes('沟通') || btn.textContent.includes('打招呼'))) return btn;
    for (const el of document.querySelectorAll('a, button')) {
      const t = (el.textContent || '').trim();
      if ((t === '立即沟通' || t.includes('打招呼')) && el.offsetParent && el.children.length === 0) return el;
    }
    return null;
  }

  // ==================== 聊天输入/发送（增强版） ====================
  function findChatInput() {
    const sel = 'textarea, div[contenteditable="true"], [role="textbox"], .chat-input, #chat-input, .chat-editor';
    const prefer = (el) => el && el.offsetParent !== null && !el.disabled;
    // 优先在聊天容器内找
    const containers = ['.chat-footer', '.chat-input-wrap', '.chat-input-box', '.chat-editor', '.chat-main', '.chat-container', '.chat-detail', '.chat-panel'];
    for (const c of containers) {
      const box = document.querySelector(c);
      if (box) {
        const inner = box.querySelector('textarea') || box.querySelector('div[contenteditable="true"]') || box.querySelector('[role="textbox"]');
        if (prefer(inner)) return inner;
      }
    }
    // 全局可见的 textarea / contenteditable
    for (const el of document.querySelectorAll(sel)) {
      if (prefer(el) && (el.tagName === 'TEXTAREA' || el.isContentEditable)) return el;
    }
    // iframe
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const doc = f.contentDocument; if (!doc) continue;
        for (const el of doc.querySelectorAll('textarea, [contenteditable="true"]')) {
          if (el.offsetParent !== null) return el;
        }
      } catch (e) {}
    }
    return null;
  }

  function findSendButton() {
    const sels = ['.btn-send', '.send-btn', 'button.send', '.chat-send-btn', '.btn-chat-send', '[class*="send-btn"]', '[class*="btn-send"]'];
    for (const s of sels) { const el = document.querySelector(s); if (el && el.offsetParent && !el.disabled) return el; }
    for (const el of document.querySelectorAll('button, a, div[class]')) {
      if (el.offsetParent && !el.disabled && el.children.length === 0 && (el.textContent || '').trim() === '发送') return el;
    }
    return null;
  }

  function setInputValue(input, msg) {
    input.focus();
    if (input.isContentEditable) {
      input.textContent = msg;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
    } else {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, msg); else input.value = msg;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function sendMessageInChat(msg) {
    const input = findChatInput();
    if (!input) return false;
    try {
      if (stopRequested) return false;
      setInputValue(input, msg);
      await sleep(600);
      for (let i = 0; i < 3; i++) {
        if (stopRequested) return false; // 发送重试期间点了停止，立即放弃
        const send = findSendButton();
        if (send) {
          send.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          send.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          send.click();
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
        await sleep(1000);
        // 校验：发送成功后输入框会被清空
        const val = input.isContentEditable ? input.textContent : input.value;
        if (!val || !val.trim()) return true;
      }
      return false;
    } catch (e) { console.log('send err', e); return false; }
  }

  // ==================== 聊天页流程 ====================
  async function chatFlow(s) {
    setRunningUI(true);
    log('💬 聊天页，发送中...');
    await sleep(3000); // 等聊天加载

    if (stopRequested) { location.href = s.jobsUrl || '/web/geek/jobs'; return; }

    let input = findChatInput();
    for (let i = 0; i < 8 && !input; i++) { await sleep(600); input = findChatInput(); }

    if (input) {
      const greeting = s.greeting || GM_getValue(GREETING_KEY, '') || fillTemplate(s.jobTitle, s.jobCompany);
      const sent = await sendMessageInChat(greeting);
      if (sent) {
        markApplied(s.jobId || ('chat_' + Date.now()), s.jobTitle || '', s.jobCompany || '');
        updateCount();
        log('✅ 已发送');
      } else if (!stopRequested) { addSkip(s.jobId); log('⚠️ 发送失败'); }
    } else if (!stopRequested) { addSkip(s.jobId); log('❌ 无输入框'); }

    await sleep(1200);
    if (stopRequested) { clearSession(); return; } // 已停止：不再跳回续跑
    // 跳回职位列表页（全量刷新销毁旧上下文），【注意：不清理会话，列表页靠它恢复循环】
    location.href = s.jobsUrl && s.jobsUrl.includes('/jobs') ? s.jobsUrl : '/web/geek/jobs';
  }

  // ==================== 职位列表页循环 ====================
  async function resumeLoop() {
    let first = true;
    while (running && !stopRequested) {
      if (getTodayCount() >= getDailyLimit()) { log('✅ 达到今日配额'); break; }

      if (!first) {
        const w = getIntervalSec();
        log(`⏳ ${w}s`);
        for (let i = 0; i < w && running && !stopRequested; i++) await sleep(1000);
      }
      first = false;
      if (stopRequested || !running) break;

      // 等待卡片渲染完成，避免"刚跳回页面没卡片就退出"
      const cards = await waitForCards();
      if (!cards || !cards.length) {
        log('⚠️ 无卡片，尝试翻页');
        const next = document.querySelector('.page-next:not(.disabled), .next-page:not(.disabled)');
        if (next) { next.click(); await sleep(3000); continue; }
        log('⏹ 没有更多职位');
        break;
      }
      log(`本轮 ${cards.length} 个卡片`);

      for (const card of cards) {
        if (!running || stopRequested) break;
        if (getTodayCount() >= getDailyLimit()) break;

        try {
          card.scrollIntoView({ behavior: 'instant', block: 'center' });
          card.click();
          await sleep(2000);
          if (stopRequested) break;
          let info = getJobInfoFromPage(card);
          if (!info.title || !info.company) { card.click(); await sleep(2000); info = getJobInfoFromPage(card); }
          if (!info.title || !info.company) { log('⚠️ 无职位信息，跳过'); continue; }
          if (isApplied(info.jobId) || isSkipped(info.jobId)) continue;

          // 生成招呼语：优先用户自定义（持久化，可留空），其次 AI，最后模板
          const useAI = document.getElementById('bap-ai')?.checked !== false;
          let greeting = '';
          const custom = GM_getValue(GREETING_KEY, '') || document.getElementById('bap-greeting')?.value?.trim() || '';
          if (custom) {
            greeting = custom.replace('{title}', info.title).replace('{company}', info.company);
          } else if (useAI) {
            const tpls = getTemplates();
            const tpl = tpls[Math.floor(Math.random() * tpls.length)];
            greeting = await callAI(tpl, info.title, info.company, info.jd);
          }
          if (stopRequested) break; // AI 等待期间可能点了停止
          if (!greeting) greeting = fillTemplate(info.title, info.company);
          log(`👉 ${info.title.substring(0, 20)} @ ${info.company}`);

          // 点击前保存会话（跳页后恢复用）——停止后绝不允许再写入
          if (stopRequested) break;
          setSession({ running: true, jobsUrl: location.href, jobId: info.jobId, jobTitle: info.title, jobCompany: info.company, greeting, ts: Date.now() });

          const btn = findGreetButton();
          if (!btn) { log('❌ 无沟通按钮'); continue; }
          if (stopRequested) break;
          btn.click();

          await sleep(2500);
          if (stopRequested) break; // 已点停止：即使页面未跳转也立即退出
          if (isChatPage()) {
            // 已跳转到聊天页，当前上下文即将/已被销毁，由 chatFlow 接手
            return;
          }
          // 未跳页：聊天以弹窗/内嵌形式打开，就地发送
          const ok = await sendMessageInChat(greeting);
          if (ok) {
            markApplied(info.jobId, info.title, info.company);
            updateCount();
            log('✅ 已投');
          } else if (!stopRequested) { addSkip(info.jobId); log('⚠️ 发送失败'); }
          clearSession();
        } catch (e) { log(`❌ ${e.message}`); }
        if (stopRequested) break;
      }

      // 本轮结束，翻页或结束
      if (!stopRequested && running) {
        const next = document.querySelector('.page-next:not(.disabled), .next-page:not(.disabled)');
        if (next) { next.click(); await sleep(3000); } else break;
      }
    }
    if (running) log('⏹ 没有更多职位');
    running = false; stopRequested = false;
    clearSession();
    setRunningUI(false);
  }

  // ==================== 初始化（每次页面加载都会执行） ====================
  function init() {
    if (!isJobsPage() && !isChatPage()) return;
    createPanel();
    updateCount();

    const s = getSession();
    if (s && s.running) {
      if (isChatPage()) {
        chatFlow(s);
        return;
      }
      if (isJobsPage() && Date.now() - (s.ts || 0) < FRESH_MS) {
        log('↩️ 从聊天页返回，继续投递');
        running = true; stopRequested = false;
        setRunningUI(true);
        resumeLoop();
        return;
      }
      if (isJobsPage()) { clearSession(); log('⏹ 过期会话已清除'); }
    }
    log('✅ v4.2就绪 · 今日: ' + getTodayCount() + '/' + getDailyLimit());
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(init, 1500); }
  }).observe(document.querySelector('title') || document.body, { subtree: true, childList: true });

})();
