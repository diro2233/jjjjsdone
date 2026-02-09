//2026-02-10-01-17
let timer = null;
let seen = new Set();
let running = false;

// Token 管理
let token = "";
let tokenExpireTime = 0;

// 重试配置
const RETRY_DELAYS = [1000, 3000, 5000];
const FAST_RETRY_DELAY = 0;
const BURST_MS = 2000;
const BURST_CONCURRENCY = 12;
const SUSTAIN_CONCURRENCY = 6;

// 新增：定时任务管理
let scheduledTasks = [];
let taskCheckTimer = null;

// 命中商品列表（用于页面底部展示）
let matchedGoodsList = [];

function log(msg) {
  const el = document.getElementById("log");
  const timestamp = new Date().toLocaleTimeString();
  el.innerHTML += `[${timestamp}] ${msg}<br>`;
  el.scrollTop = el.scrollHeight;
}

function showStatus(msg, type = 'success') {
  const statusBar = document.getElementById('statusBar');
  statusBar.textContent = msg;
  statusBar.className = 'status-bar';
  if (type === 'error') statusBar.classList.add('error');
  if (type === 'warning') statusBar.classList.add('warning');
  statusBar.classList.remove('hidden');
}

function onTypeChange() {
  const type = document.getElementById("type").value;
  document.getElementById("jobBox").classList.toggle("hidden", type !== "99");
  document.getElementById("equipBox").classList.toggle("hidden", type !== "1");
}

function getCheckedJobs() {
  return Array.from(document.querySelectorAll('.job-checkbox:checked'))
    .map(i => i.value)
    .join(",");
}

function getCheckedEquipments() {
  return Array.from(document.querySelectorAll('.equip-checkbox:checked'))
    .map(i => i.value)
    .join(",");
}

function buildApiUrl(skip, maxCount) {
  const type = typeEl.value;
  const priceStart = priceStartEl.value;
  const priceEnd = priceEndEl.value;
  const timestamp = Date.now();
  
  let url = `https://api.52108.com/api/services/cbg/Goods/GetIndexGoodsPaged?GameServerId=&TypeList=&PriceStart=${priceStart}&PriceEnd=${priceEnd}&EquipmentTypeList=&Id=&Name=&Sorting=&SkipCount=${skip}&MaxResultCount=${maxCount}&OnlyPlayed=false&time=${timestamp}&type=${type}`;
  
  if (type === "99") {
    const jobList = getCheckedJobs();
    if (jobList) {
      url += `&RoleJobList=${encodeURIComponent(jobList)}`;
    }
  }
  
  if (type === "1") {
    const equipList = getCheckedEquipments();
    if (equipList) {
      url = url.replace('EquipmentTypeList=', `EquipmentTypeList=${encodeURIComponent(equipList)}`);
    }
  }
  
  return url;
}

async function fetchTotal() {
  const url = buildApiUrl(0, 1);
  const res = await fetch(url);
  const data = await res.json();
  return data.result?.totalCount || 0;
}

async function fetchAllItems(total) {
  const pageSize = 50;
  let items = [];

  for (let skip = 0; skip < total; skip += pageSize) {
    if (!running) break;

    const url = buildApiUrl(skip, pageSize);

    const res = await fetch(url);
    const data = await res.json();

    items = items.concat(data.result?.items || []);

    await new Promise(r => setTimeout(r, 200));
  }

  return items;
}

async function getRoleExtra(goodsId) {
  const t0 = Date.now();
  const res = await fetch(`https://api.52108.com/api/services/app/GameRoleInfo/GetGameRoleInfo?GoodsId=${goodsId}`);
  const j = await res.json();
  const html = j.result[0].data;

  const cardMatch = html.match(/月卡到期时间：.*?val'>(.*?)</);
  let days = 0;
  if (cardMatch && cardMatch[1] !== "无月卡") {
    days = Math.floor((new Date(cardMatch[1]) - new Date()) / 86400000);
  }

  const flowMatch = html.match(/流派：.*?val'>(.*?)</);
  const flow = flowMatch ? flowMatch[1] : "";

  const rechargeMatch = html.match(/充值：.*?val'>(\d+)</);
  const recharge = rechargeMatch ? Number(rechargeMatch[1]) : 0;

  const cost = Date.now() - t0;
  return { days, flow, recharge, cost };
}

function parseFlows(text) {
  if (!text) return [];
  return text.split(/[,\s、，]+/).map(s => s.trim()).filter(Boolean);
}

function matchFlow(target, flows) {
  if (flows.length === 0) return true;
  return flows.some(f => target.includes(f));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTerminalOrderError(message) {
  if (!message) return false;
  const msg = String(message);
  return (
    msg.includes("当前商品交易中") ||
    msg.includes("已售") ||
    msg.includes("不存在") ||
    msg.includes("下架") ||
    msg.includes("库存不足") ||
    msg.includes("不可购买")
  );
}

async function rushOrder(goodsId) {
  const start = Date.now();
  const burstEnd = start + BURST_MS;
  let active = 0;
  let done = false;
  let finalResult = null;

  const spawn = () => {
    if (done) return;
    active++;
    (async () => {
      try {
        const res = await createOrder(goodsId, 0, { fastRetry: true, maxRetryOverride: 0 });
        if (res && res.success) {
          done = true;
          finalResult = res;
        } else if (res && res.scheduledTask) {
          done = true;
          finalResult = res;
        } else {
          const msg = JSON.stringify(res?.error?.message || res);
          if (isTerminalOrderError(msg)) {
            done = true;
            finalResult = { success: false, terminalError: true, message: msg };
          }
        }
      } catch (e) {
        const msg = e?.message || String(e);
        if (isTerminalOrderError(msg)) {
          done = true;
          finalResult = { success: false, terminalError: true, message: msg };
        }
      } finally {
        active--;
      }
    })();
  };

  while (!done) {
    const now = Date.now();
    const targetConcurrency = now <= burstEnd ? BURST_CONCURRENCY : SUSTAIN_CONCURRENCY;
    while (!done && active < targetConcurrency) {
      spawn();
    }
    if (done) break;
    await delay(FAST_RETRY_DELAY);
  }

  return finalResult;
}

function saveToken(accessToken) {
  token = accessToken;
  tokenExpireTime = Date.now() + 23 * 60 * 60 * 1000;
  
  const tokenData = {
    token: accessToken,
    expireTime: tokenExpireTime,
    username: usernameEl.value.trim()
  };
  
  localStorage.setItem("barkMonitorToken", JSON.stringify(tokenData));
  log("✔ Token 已保存到本地存储");
}

function loadToken() {
  const tokenStr = localStorage.getItem("barkMonitorToken");
  if (!tokenStr) return false;
  
  try {
    const tokenData = JSON.parse(tokenStr);
    
    if (tokenData.expireTime && tokenData.expireTime > Date.now()) {
      if (tokenData.username === usernameEl.value.trim()) {
        token = tokenData.token;
        tokenExpireTime = tokenData.expireTime;
        
        const remainHours = Math.floor((tokenExpireTime - Date.now()) / 3600000);
        log(`✔ 已加载本地 Token（剩余有效期约 ${remainHours} 小时）`);
        showStatus(`Token 有效，剩余 ${remainHours} 小时`, 'success');
        return true;
      } else {
        log("本地 Token 用户名不匹配，需重新登录");
      }
    } else {
      log("本地 Token 已过期，需重新登录");
    }
  } catch (e) {
    log("加载本地 Token 失败: " + e.message);
  }
  
  localStorage.removeItem("barkMonitorToken");
  token = "";
  tokenExpireTime = 0;
  return false;
}

function isTokenExpiringSoon() {
  if (!token || !tokenExpireTime) return true;
  return (tokenExpireTime - Date.now()) < 60 * 60 * 1000;
}

async function login(user, pass, retryCount = 0) {
  const maxRetry = Number(loginRetryEl.value) || 3;
  
  try {
    log(`正在登录... (尝试 ${retryCount + 1}/${maxRetry + 1})`);
    showStatus(`登录中... (尝试 ${retryCount + 1}/${maxRetry + 1})`, 'warning');
    
    const res = await fetch("https://api.52108.com/api/TokenAuth/AccountAuthenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: user, password: pass })
    });
    
    const data = await res.json();
    
    if (!data.success) {
      throw new Error(data.error?.message || "登录失败");
    }
    
    saveToken(data.result.accessToken);
    log("✔ 登录成功");
    showStatus("登录成功", 'success');
    return true;
    
  } catch (e) {
    log(`✘ 登录失败: ${e.message}`);
    
    if (retryCount < maxRetry) {
      const delayMs = RETRY_DELAYS[retryCount] || 5000;
      log(`${delayMs / 1000} 秒后重试登录...`);
      await delay(delayMs);
      return login(user, pass, retryCount + 1);
    } else {
      log(`✘ 登录失败，已达最大重试次数 (${maxRetry + 1})`);
      showStatus(`登录失败: ${e.message}`, 'error');
      throw new Error("登录失败: " + e.message);
    }
  }
}

async function ensureLogin() {
  const user = usernameEl.value.trim();
  const pass = passwordEl.value.trim();
  
  if (!user || !pass) {
    throw new Error("请填写账号和密码");
  }
  
  if (token && !isTokenExpiringSoon()) {
    return true;
  }
  
  if (!token && loadToken()) {
    return true;
  }
  
  log("Token 无效或即将过期，正在重新登录...");
  return await login(user, pass);
}

// 新增：查询商品详情获取公示结束时间
async function getGoodsDetail(goodsId) {
  try {
    const res = await fetch(`https://api.52108.com/api/services/cbg/Goods/GetById?id=${goodsId}`);
    const data = await res.json();
    
    if (data.success && data.result) {
      return data.result;
    }
    return null;
  } catch (e) {
    log(`查询商品详情失败 ID=${goodsId}: ${e.message}`);
    return null;
  }
}

// 新增：创建定时下单任务
async function createScheduledTask(goodsId, errorMessage) {
  const existing = scheduledTasks.find(t => t.goodsId === goodsId);
  if (existing) {
    log(`⏰ 商品ID=${goodsId} 已有定时任务，不再重复创建`);
    return existing;
  }

  log(`⏰ 检测到公示期限制，正在查询商品详情...`);
  
  const goodsDetail = await getGoodsDetail(goodsId);
  
  if (!goodsDetail || !goodsDetail.noticeEndTime) {
    log(`✘ 无法获取商品 ID=${goodsId} 的公示结束时间`);
    return;
  }
  
  const noticeEndTime = new Date(goodsDetail.noticeEndTime);
  const taskId = `task_${goodsId}_${Date.now()}`;
  
  const task = {
    id: taskId,
    goodsId: goodsId,
    goodsName: goodsDetail.name || `商品${goodsId}`,
    server: goodsDetail.gameServer?.subName || "未知区服",
    price: goodsDetail.price,
    noticeEndTime: noticeEndTime.getTime(),
    noticeEndTimeStr: goodsDetail.noticeEndTime,
    status: 'pending', // pending, success, expired, error
    statusMessage: '',
    createTime: Date.now(),
    orderNumber: null
  };
  
  scheduledTasks.push(task);
  saveScheduledTasks();
  renderTaskList();
  
  const timeUntil = noticeEndTime - new Date();
  log(`✔ 已创建定时任务: ${task.goodsName} | ${task.server} | ${task.price}元 | 将在 ${noticeEndTime.toLocaleString()} 自动下单`);
  
  await pushBark("创建定时下单任务", `${task.goodsName} | ${task.server} | ${task.price}元 | ${noticeEndTime.toLocaleString()}`, `http://dms.52108.com/#/pages/shop/detail?id=${goodsId}`);
  return task;
}

// 新增：保存定时任务到本地存储
function saveScheduledTasks() {
  localStorage.setItem("scheduledTasks", JSON.stringify(scheduledTasks));
}

// 新增：从本地存储加载定时任务
function loadScheduledTasks() {
  const tasksStr = localStorage.getItem("scheduledTasks");
  if (!tasksStr) return;
  
  try {
    scheduledTasks = JSON.parse(tasksStr);
    log(`✔ 已加载 ${scheduledTasks.length} 个定时任务`);
    renderTaskList();
  } catch (e) {
    log("加载定时任务失败: " + e.message);
    scheduledTasks = [];
  }
}

// 新增：删除定时任务
function deleteTask(taskId) {
  scheduledTasks = scheduledTasks.filter(t => t.id !== taskId);
  saveScheduledTasks();
  renderTaskList();
  log(`已删除任务 ${taskId}`);
}

// 新增：渲染任务列表
function renderTaskList() {
  const container = document.getElementById('taskList');
  
  if (scheduledTasks.length === 0) {
    container.innerHTML = '<div class="no-tasks">暂无定时任务</div>';
    return;
  }
  
  const now = Date.now();
  
  container.innerHTML = scheduledTasks.map(task => {
    const noticeEndTime = task.noticeEndTime;
    const timeRemaining = noticeEndTime - now;
    
    let statusClass = task.status;
    let statusText = '';
    let countdown = '';
    
    if (task.status === 'success') {
      const paymentLink = task.orderId 
        ? ` | <a href="${getPaymentUrl(task.orderId)}" target="_blank" style="color: #ff6a00; font-weight: bold;">点击去付款</a>`
        : '';
      statusText = `下单成功 订单号:${task.orderNumber}${paymentLink}`;
    } else if (task.status === 'error') {
      statusText = `下单失败: ${task.statusMessage}`;
    } else if (task.status === 'processing') {
      statusText = '下单中...';
    } else if (timeRemaining < 0) {
      statusText = '已过期';
      statusClass = 'expired';
    } else {
      statusText = '等待中';
      const hours = Math.floor(timeRemaining / 3600000);
      const minutes = Math.floor((timeRemaining % 3600000) / 60000);
      const seconds = Math.floor((timeRemaining % 60000) / 1000);
      countdown = `<span class="task-countdown">倒计时: ${hours}h ${minutes}m ${seconds}s</span>`;
    }
    
    return `
      <div class="task-item ${statusClass}">
        <button class="task-delete" onclick="deleteTask('${task.id}')">删除</button>
        <div class="task-info">
          <div>
            <strong>${task.goodsName}</strong>
            <span class="task-status ${statusClass}">${statusText}</span>
          </div>
          <div>商品ID: <a href="http://dms.52108.com/#/pages/shop/detail?id=${task.goodsId}" target="_blank" style="color: #4da3ff; text-decoration: underline;">${task.goodsId}</a> | 区服: ${task.server} | 价格: ${task.price}元</div>
          <div>开始购买时间: ${new Date(noticeEndTime).toLocaleString()}</div>
          ${countdown ? `<div>${countdown}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// 渲染命中商品列表
function renderMatchedGoodsList() {
  const container = document.getElementById('matchedGoodsList');
  if (!container) return;
  if (matchedGoodsList.length === 0) {
    container.innerHTML = '<div class="no-matched">暂无命中记录，开始监听后命中会显示在此</div>';
    return;
  }
  container.innerHTML = matchedGoodsList.map(m => {
    const url = `http://dms.52108.com/#/pages/shop/detail?id=${m.id}`;
    return `
      <div class="matched-item">
        <span class="matched-name">${escapeHtml(m.name)}</span>
        <span class="matched-meta">ID: <a href="${url}" target="_blank">${m.id}</a></span>
        <span class="matched-meta">区服: ${escapeHtml(m.server)}</span>
        <span class="matched-meta">价格: ${m.price}元</span>
        <span class="matched-meta">充值: ${m.recharge}</span>
        <span class="matched-meta">月卡: ${m.days}天</span>
        <span class="matched-meta">流派: ${escapeHtml(m.flow)}</span>
        <span class="matched-meta">${m.hitTime}</span>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// 新增：检查并执行到期的定时任务
async function checkScheduledTasks() {
  const now = Date.now();
  
  for (const task of scheduledTasks) {
    // 跳过已完成、已过期、正在处理中的任务
    if (task.status !== 'pending') continue;
    
    const timeUntil = task.noticeEndTime - now;
    
    // 如果时间到了（提前3秒执行）
    if (timeUntil <= 3000 && timeUntil > -60000) { // 提前3秒，但不超过1分钟过期
      // 立即标记为处理中，防止检查器下一秒再次触发同一任务
      task.status = 'processing';
      task.statusMessage = '下单中...';
      saveScheduledTasks();
      renderTaskList();
      
      log(`⏰ 定时任务到期，开始下单: ${task.goodsName} (ID=${task.goodsId})`);
      
      try {
        const orderRes = await rushOrder(task.goodsId);
        
        if (orderRes && orderRes.success) {
          const orderId = orderRes.result.id;
          const orderNumber = orderRes.result.orderNumber;
          const paymentUrl = getPaymentUrl(orderId);
          const paymentLink = `<a href="${paymentUrl}" target="_blank">点击去付款</a>`;
          
          task.status = 'success';
          task.orderId = orderId; // 保存订单ID用于生成支付链接
          task.orderNumber = orderNumber;
          task.statusMessage = '下单成功';
          log(`✔ 定时任务下单成功 订单号=${orderNumber} | ${paymentLink}`);
          
          // Bark 推送包含支付链接
          await pushBark("定时下单成功", `${task.goodsName} | 订单号:${orderNumber} | 点击去付款`, paymentUrl);
        } else if (orderRes && orderRes.scheduledTask) {
          task.status = 'pending';
          task.statusMessage = '公示期限制';
          log(`⏰ 仍在公示期，继续等待: ID=${task.goodsId}`);
        } else if (orderRes && orderRes.terminalError) {
          task.status = 'error';
          task.statusMessage = orderRes.message;
          log(`✘ 定时任务下单失败: ${orderRes.message}`);
        } else {
          task.status = 'error';
          task.statusMessage = '下单失败';
          log(`✘ 定时任务下单失败: 未知错误`);
        }
      } catch (e) {
        task.status = 'error';
        task.statusMessage = e.message;
        log(`✘ 定时任务下单异常: ${e.message}`);
      }
      
      saveScheduledTasks();
      renderTaskList();
      return; // 本次只处理一个任务，避免同一秒内多个任务同时下单
    }
    // 如果已经超时超过1分钟，标记为过期
    else if (timeUntil < -60000) {
      task.status = 'expired';
      task.statusMessage = '任务已过期';
      saveScheduledTasks();
      renderTaskList();
    }
  }
}

// 新增：启动定时任务检查器
function startTaskChecker() {
  if (taskCheckTimer) return;
  
  taskCheckTimer = setInterval(() => {
    checkScheduledTasks();
    renderTaskList(); // 更新倒计时显示
  }, 300); // 每 300ms 检查一次，更快卡点抢单
  
  log("✔ 定时任务检查器已启动");
}

// 新增：停止定时任务检查器
function stopTaskChecker() {
  if (taskCheckTimer) {
    clearInterval(taskCheckTimer);
    taskCheckTimer = null;
  }
}

async function createOrder(goodsId, retryCount = 0, options = {}) {
  const maxRetry = Number.isInteger(options.maxRetryOverride)
    ? options.maxRetryOverride
    : (Number(orderRetryEl.value) || 3);
  const fastRetry = options.fastRetry === true;
  
  try {
    await ensureLogin();
    
    log(`正在生成订单 ID=${goodsId}... (尝试 ${retryCount + 1}/${maxRetry + 1})`);
    
    const t0 = Date.now();
    const res = await fetch("https://api.52108.com/api/services/cbg/Order/Create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({ goodsId: Number(goodsId) })
    });
    const t1 = Date.now();
    log(`⏱ 下单请求耗时 ${t1 - t0} ms (HTTP ${res.status}) ID=${goodsId}`);
    
    if (res.status === 401) {
      log("⚠ 检测到 401 未授权，Token 已失效");
      localStorage.removeItem("barkMonitorToken");
      token = "";
      tokenExpireTime = 0;
      
      if (retryCount < maxRetry) {
        log("正在重新登录...");
        await ensureLogin();
        return createOrder(goodsId, retryCount + 1, options);
      } else {
        throw new Error("401 未授权，Token 失效");
      }
    }
    
    const data = await res.json();
    
    // 关键修复：优先检测公示期错误码 1011，不重试，直接创建定时任务
    if (!data.success && data.error?.code === 1011) {
      log(`⚠ ${data.error.message}`);
      await createScheduledTask(goodsId, data.error.message);
      // 返回特殊标记，表示已创建定时任务
      return { success: false, scheduledTask: true, error: data.error };
    }
    
    if (!data.success) {
      throw new Error(data.error?.message || JSON.stringify(data));
    }
    
    return data;
    
  } catch (e) {
    // 如果是字符串错误且包含"公示期"，也创建定时任务
    if (e.message && e.message.includes("公示期")) {
      log(`⚠ 检测到公示期限制: ${e.message}`);
      await createScheduledTask(goodsId, e.message);
      return { success: false, scheduledTask: true, error: { message: e.message } };
    }
    
    log(`✘ 下单失败 (尝试 ${retryCount + 1}/${maxRetry + 1}): ${e.message}`);
    
    if (retryCount < maxRetry) {
      const delayMs = fastRetry ? FAST_RETRY_DELAY : (RETRY_DELAYS[retryCount] || 5000);
      if (!fastRetry) {
        log(`${delayMs / 1000} 秒后重试下单...`);
      }
      if (delayMs > 0) {
        await delay(delayMs);
      }
      return createOrder(goodsId, retryCount + 1, options);
    } else {
      log(`✘ 下单失败，已达最大重试次数 (${maxRetry + 1})`);
      throw e;
    }
  }
}

async function manualCreateOrder() {
  const gid = manualGoodsIdEl.value.trim();
  if (!gid) {
    log("请输入要下单的 goodsId");
    return;
  }

  try {
    const res = await createOrder(gid);
    
    if (res.success) {
      const orderId = res.result.id;
      const orderNumber = res.result.orderNumber;
      const paymentUrl = getPaymentUrl(orderId);
      const paymentLink = `<a href="${paymentUrl}" target="_blank">点击去付款</a>`;
      
      log(`✔ 手动下单成功 订单号=${orderNumber} | ${paymentLink}`);
      showStatus(`手动下单成功 订单号=${orderNumber}`, 'success');
      
      // Bark 推送包含支付链接
      await pushBark("手动下单成功", `订单号:${orderNumber} | 点击去付款`, paymentUrl);
    } else if (res.scheduledTask) {
      log(`⏰ 检测到公示期，已创建定时任务`);
      showStatus("已创建定时任务，将自动下单", 'warning');
    } else {
      log("✘ 手动下单失败:\n" + JSON.stringify(res, null, 2));
      showStatus("手动下单失败", 'error');
    }
  } catch (e) {
    log("手动下单异常: " + e.message);
    showStatus("手动下单异常: " + e.message, 'error');
  }
}

// 生成支付链接
function getPaymentUrl(orderId) {
  return `http://dms.52108.com/#/pages/trade/detail?id=${orderId}`;
}

async function pushBark(title, body, url) {
  const bark = barkEl.value.trim();
  if (!bark) return;
  const soundParam = "sound=update";
  const api = barkJumpEl.checked && url
    ? `${bark}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?url=${encodeURIComponent(url)}&${soundParam}`
    : `${bark}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?${soundParam}`;
  
  try {
    await fetch(api);
    log("✔ Bark 推送成功");
  } catch (e) {
    log("✘ Bark 推送失败: " + e.message);
  }
}

async function check() {
  if (!running) return;

  try {
    const total = await fetchTotal();
    
    const type = typeEl.value;
    let filterInfo = `价格${priceStartEl.value}-${priceEndEl.value}`;
    if (type === "99") {
      const jobs = getCheckedJobs();
      if (jobs) filterInfo += ` | 职业=${jobs}`;
    }
    if (type === "1") {
      const equips = getCheckedEquipments();
      if (equips) filterInfo += ` | 装备=${equips}`;
    }
    
    log(`当前市场基础筛选总数：${total} (${filterInfo})`);

    if (total === 0) return;

    const items = await fetchAllItems(total);

    const needDays = Number(cardDaysEl.value);
    const needRecharge = Number(rechargeEl.value);
    const needFlows = parseFlows(flowEl.value.trim());
    const debug = debugEl.checked;

    let matchCount = 0;

    const batchSize = Math.max(1, Number(batchSizeEl.value) || 1);

    for (let i = 0; i < items.length; i += batchSize) {
      if (!running) return;

      const batch = items.slice(i, i + batchSize);

      const results = await Promise.all(batch.map(async (item) => {
        try {
          const extra = await getRoleExtra(item.id);
          const server = item.gameServer?.subName || "未知区服";

          const okDays = extra.days >= needDays;
          const okRecharge = extra.recharge >= needRecharge;
          const okFlow = matchFlow(extra.flow, needFlows);

          if (debug) {
            log(`检测ID=${item.id} | 区服=${server} | 价格=${item.price} | 充值=${extra.recharge}${okRecharge ? "✔" : "✘"} | 月卡=${extra.days}${okDays ? "✔" : "✘"} | 流派=${extra.flow}${okFlow ? "✔" : "✘"} | 耗时=${extra.cost}ms`);
          }

          if (!okDays || !okRecharge || !okFlow) return null;
          if (seen.has(item.id)) return null;

          return { item, extra, server };
        } catch (e) {
          log(`检测商品 ID=${item.id} 时出错: ${e.message}`);
          return null;
        }
      }));

      for (const r of results) {
        if (!r) continue;

        seen.add(r.item.id);
        matchCount++;

        // 加入命中商品列表（最新在前）
        matchedGoodsList.unshift({
          id: r.item.id,
          name: r.item.name || `商品${r.item.id}`,
          server: r.server,
          price: r.item.price,
          recharge: r.extra.recharge,
          days: r.extra.days,
          flow: r.extra.flow,
          hitTime: new Date().toLocaleString()
        });
        renderMatchedGoodsList();

        const url = `http://dms.52108.com/#/pages/shop/detail?id=${r.item.id}`;
        const msg = `<a href="${url}" target="_blank">命中ID=${r.item.id} 区服=${r.server} 价格=${r.item.price} 充值=${r.extra.recharge} 月卡=${r.extra.days} 流派=${r.extra.flow}</a>`;
        log(msg);
        
        if (autoOrderEl.checked) {
          try {
            const orderRes = await createOrder(r.item.id);
            if (orderRes.success) {
              const orderId = orderRes.result.id;
              const orderNumber = orderRes.result.orderNumber;
              const paymentUrl = getPaymentUrl(orderId);
              const paymentLink = `<a href="${paymentUrl}" target="_blank">点击去付款</a>`;
              
              log(`✔ 已自动下单 订单号=${orderNumber} | ${paymentLink}`);
              showStatus(`自动下单成功 ID=${r.item.id}`, 'success');
              
              // Bark 推送包含支付链接
              await pushBark("自动下单成功", `ID=${r.item.id} 订单号:${orderNumber} | 点击去付款`, paymentUrl);
            } else if (orderRes.scheduledTask) {
              log(`⏰ 检测到公示期，已创建定时任务 ID=${r.item.id}`);
              showStatus(`已创建定时任务 ID=${r.item.id}`, 'warning');
            } else {
              log(`✘ 自动下单失败: ${JSON.stringify(orderRes)}`);
            }
          } catch (e) {
            log("自动下单异常: " + e.message);
          }
        } else {
          // 如果没有自动下单，推送商品信息
          await pushBark("发现符合条件商品", `ID=${r.item.id} 区服=${r.server} 价格=${r.item.price} 充值=${r.extra.recharge} 月卡=${r.extra.days} 流派=${r.extra.flow}`, url);
        }
      }
    }

    log(`本轮命中 ${matchCount} 个 | 累计推送 ${seen.size} 个`);
    showStatus(`运行中 - 本轮命中 ${matchCount} 个`, 'success');

    const intervalSec = Number(intervalEl.value);
    if (intervalSec === 0) {
      log("轮询间隔=0，立即开始下一轮...");
      setTimeout(check, 0);
    } else {
      const nextTime = new Date(Date.now() + intervalSec * 1000);
      log(`下次开始时间：${nextTime.toLocaleString()}`);
    }
  } catch (e) {
    log("错误: " + e.message);
    showStatus("检测出错: " + e.message, 'error');
    
    if (running) {
      log("10 秒后继续监听...");
      await delay(10000);
    }
  }
}

function startMonitor() {
  stopMonitor();
  running = true;
  const interval = Number(intervalEl.value) * 1000;
  log("开始监听...");
  showStatus("监听已启动", 'success');
  
  loadToken();
  startTaskChecker(); // 启动定时任务检查器
  
  check();
  timer = setInterval(check, interval);
}

function stopMonitor() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  log("已停止监听");
  showStatus("监听已停止", 'warning');
}

function saveSettings() {
  const settings = {
    priceStart: priceStartEl.value,
    priceEnd: priceEndEl.value,
    cardDays: cardDaysEl.value,
    recharge: rechargeEl.value,
    flow: flowEl.value,
    bark: barkEl.value,
    barkJump: barkJumpEl.checked,
    interval: intervalEl.value,
    debug: debugEl.checked,
    username: usernameEl.value,
    password: passwordEl.value,
    autoOrder: autoOrderEl.checked,
    loginRetry: loginRetryEl.value,
    orderRetry: orderRetryEl.value,
    batchSize: batchSizeEl.value,
    selectedJobs: getCheckedJobs(),
    selectedEquips: getCheckedEquipments(),
    type: typeEl.value
  };
  localStorage.setItem("barkMonitorSettings", JSON.stringify(settings));
  log("设置已保存");
  showStatus("设置已保存", 'success');
}

function loadSettings() {
  const s = localStorage.getItem("barkMonitorSettings");
  if (!s) return;
  const settings = JSON.parse(s);

  priceStartEl.value = settings.priceStart;
  priceEndEl.value = settings.priceEnd;
  cardDaysEl.value = settings.cardDays;
  rechargeEl.value = settings.recharge || 0;
  flowEl.value = settings.flow || "";
  barkEl.value = settings.bark;
  barkJumpEl.checked = settings.barkJump;
  intervalEl.value = settings.interval;
  debugEl.checked = settings.debug || false;
  usernameEl.value = settings.username || "";
  passwordEl.value = settings.password || "";
  autoOrderEl.checked = settings.autoOrder || false;
  loginRetryEl.value = settings.loginRetry || 3;
  orderRetryEl.value = settings.orderRetry || 3;
  batchSizeEl.value = settings.batchSize || 5;
  
  if (settings.type) {
    typeEl.value = settings.type;
  }
  
  if (settings.selectedJobs) {
    const jobs = settings.selectedJobs.split(',');
    document.querySelectorAll('.job-checkbox').forEach(cb => {
      cb.checked = jobs.includes(cb.value);
    });
  }
  
  if (settings.selectedEquips) {
    const equips = settings.selectedEquips.split(',');
    document.querySelectorAll('.equip-checkbox').forEach(cb => {
      cb.checked = equips.includes(cb.value);
    });
  }

  log("已加载保存的设置");
}

const typeEl = document.getElementById("type");
const priceStartEl = document.getElementById("priceStart");
const priceEndEl = document.getElementById("priceEnd");
const cardDaysEl = document.getElementById("cardDays");
const rechargeEl = document.getElementById("recharge");
const flowEl = document.getElementById("flow");
const barkEl = document.getElementById("bark");
const barkJumpEl = document.getElementById("barkJump");
const intervalEl = document.getElementById("interval");
const autoOrderEl = document.getElementById("autoOrder");
const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");
const manualGoodsIdEl = document.getElementById("manualGoodsId");
const debugEl = document.getElementById("debug");
const batchSizeEl = document.getElementById("batchSize");
const loginRetryEl = document.getElementById("loginRetry");
const orderRetryEl = document.getElementById("orderRetry");

loadSettings();
onTypeChange();

window.addEventListener('load', () => {
  loadToken();
  loadScheduledTasks();
  startTaskChecker(); // 页面加载时启动定时任务检查器
});

window.addEventListener('beforeunload', () => {
  if (running) {
    saveSettings();
  }
  stopTaskChecker();
});
