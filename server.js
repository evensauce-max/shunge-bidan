require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const BASE_APP_TOKEN = process.env.FEISHU_BASE_APP_TOKEN;

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '.')));

// ===== 飞书 tenant_access_token 缓存 =====
let tenantToken = { token: null, expireAt: 0 };

async function getTenantToken() {
  const now = Date.now();
  if (tenantToken.token && tenantToken.expireAt > now + 60000) {
    return tenantToken.token;
  }
  const res = await axios.post(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });
  if (res.data.code === 0) {
    tenantToken.token = res.data.tenant_access_token;
    tenantToken.expireAt = now + res.data.expire * 1000;
    return tenantToken.token;
  }
  throw new Error('获取 tenant_access_token 失败: ' + res.data.msg);
}

// ===== 飞书调用重试（限流/临时错误自动重试一次） =====
function isRetryableFeishuError(err) {
  const code = err.response?.data?.code;
  const status = err.response?.status;
  // 99991400=触发限流；429/5xx 为临时网关错误；网络层无响应也重试
  return code === 99991400 || status === 429 || (status >= 500) || !err.response;
}

async function feishuCall(fn, retries = 1) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0 && isRetryableFeishuError(err)) {
      await new Promise(r => setTimeout(r, 1000));
      return feishuCall(fn, retries - 1);
    }
    throw err;
  }
}

// ===== 通用 Base 操作 =====
// ===== 表数据短缓存（15 秒），写入时失效，避免每次保存都重拉整表做 ID 映射 =====
const tableCache = {};
const TABLE_CACHE_TTL = 15000;

function invalidateTableCache(tableId) {
  if (tableId) delete tableCache[tableId];
}

async function baseGetAllRecords(tableId) {
  const cached = tableCache[tableId];
  if (cached && Date.now() - cached.at < TABLE_CACHE_TTL) return cached.items;
  const token = await getTenantToken();
  let allItems = [];
  let pageToken = '';
  do {
    let url = `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const res = await feishuCall(() => axios.get(url, { headers: { Authorization: `Bearer ${token}` } }));
    if (res.data.code !== 0) throw new Error(res.data.msg);
    allItems = allItems.concat(res.data.data.items || []);
    pageToken = res.data.data.has_more ? res.data.data.page_token : '';
  } while (pageToken);
  tableCache[tableId] = { at: Date.now(), items: allItems };
  return allItems;
}

async function baseBatchCreate(tableId, records) {
  const token = await getTenantToken();
  const res = await feishuCall(() => axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/batch_create`,
    { records },
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  if (res.data.code !== 0) throw new Error(res.data.msg);
  invalidateTableCache(tableId);
  return res.data.data.records || [];
}

async function baseBatchUpdate(tableId, records) {
  const token = await getTenantToken();
  const res = await feishuCall(() => axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/batch_update`,
    { records },
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  if (res.data.code !== 0) throw new Error(res.data.msg);
  invalidateTableCache(tableId);
  return res.data.data.records || [];
}

async function baseBatchDelete(tableId, recordIds) {
  const token = await getTenantToken();
  const res = await feishuCall(() => axios.post(
    `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/batch_delete`,
    { records: recordIds },
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  if (res.data.code !== 0) throw new Error(res.data.msg);
  invalidateTableCache(tableId);
  return true;
}

// ===== 数据转换工具 =====
// 从飞书 link 字段提取 record_id 数组（兼容多种返回结构）
function extractLinkIds(field) {
  if (!field || !Array.isArray(field)) return [];
  const out = [];
  field.forEach(f => {
    if (typeof f === 'string') { out.push(f); return; }
    if (f.record_ids && Array.isArray(f.record_ids)) out.push(...f.record_ids);
    else if (f.id || f.record_id) out.push(f.id || f.record_id);
  });
  return out;
}

// 从飞书 select 字段提取值
function extractSelect(field) {
  if (!field) return '';
  if (Array.isArray(field)) return field[0]?.text || field[0]?.name || '';
  return field.text || field.name || field;
}

// 从飞书 multiSelect 提取值数组
function extractMultiSelect(field) {
  if (!field || !Array.isArray(field)) return [];
  return field.map(f => f.text || f.name || f);
}

// 从飞书 dateTime 字段提取日期字符串 YYYY-MM-DD
function extractDate(field) {
  if (!field) return '';
  // 飞书 dateTime 返回毫秒时间戳
  if (typeof field === 'number') {
    const d = new Date(field);
    return d.toISOString().slice(0, 10);
  }
  return field;
}

// 转成飞书 dateTime 格式（毫秒时间戳）
function toFeishuDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + 'T00:00:00').getTime();
}

// ===== 认证中间件 =====
function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '登录已过期' });
  }
}

// ===== 飞书免登 =====
app.get('/api/auth/feishu', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: '缺少 code 参数' });

  try {
    const token = await getTenantToken();

    // H5 免登：用 code 换用户身份
    const loginRes = await axios.post(
      `${FEISHU_BASE}/authen/v1/access_token`,
      { grant_type: 'authorization_code', code },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (loginRes.data.code !== 0) {
      // 降级：用 mina/token_login 再试一次
      const fallbackRes = await axios.post(
        `${FEISHU_BASE}/mina/v1/token_login`,
        { token: code },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (fallbackRes.data.code !== 0) {
        return res.status(401).json({ error: fallbackRes.data.msg || '登录失败' });
      }
      // 处理 fallback 登录结果
      const { open_id } = fallbackRes.data.data;
      const userInfoRes = await axios.get(
        `${FEISHU_BASE}/contact/v3/users/${open_id}?user_id_type=open_id`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const u = userInfoRes.data.data?.user || {};
      const user = {
        openId: open_id,
        name: u.name || '用户',
        avatar: u.avatar?.avatar_72 || u.avatar?.avatar_64 || '',
      };
      const jwtToken = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
      res.cookie('token', jwtToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
      return res.json({ user });
    }

    const { open_id, user_id, name, avatar_url } = loginRes.data.data;
    const user = {
      openId: open_id || user_id,
      name: name || '用户',
      avatar: avatar_url || '',
    };

    const jwtToken = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', jwtToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ user });
  } catch (err) {
    console.error('飞书登录错误:', err.message);
    res.status(500).json({ error: '登录失败: ' + err.message });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// 获取当前用户信息 + 角色（从人员表匹配）
app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const token = await getTenantToken();
    const personTable = process.env.FEISHU_TABLE_PERSONS;
    let userData = { ...req.user, roles: [], isAdmin: false, personId: '' };

    if (personTable) {
      // 按 feishu_open_id 查找人员表记录
      const searchRes = await axios.post(
        `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${personTable}/records/search`,
        {
          page_size: 1,
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: 'feishu_open_id', operator: 'is', value: [req.user.openId] }]
          }
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const items = searchRes.data.data?.items || [];
      if (items.length > 0) {
        const f = items[0].fields;
        userData.personId = f.person_id || items[0].record_id;
        userData.roles = extractMultiSelect(f.roles);
        userData.isAdmin = userData.roles.includes('管理员');
        userData.employmentType = extractSelect(f.employment_type);
        userData.salary = f.salary || 0;
      }
    }

    res.json({ user: userData });
  } catch (err) {
    console.error('获取用户信息错误:', err.message);
    res.json({ user: { ...req.user, roles: [], isAdmin: false, personId: '' } });
  }
});

// 写回飞书 openId 到人员表
app.put('/api/user/me', authMiddleware, async (req, res) => {
  const { personId, feishuOpenId } = req.body;
  if (!personId || !feishuOpenId) {
    return res.status(400).json({ error: '缺少 personId 或 feishuOpenId' });
  }

  try {
    const token = await getTenantToken();
    const personTable = process.env.FEISHU_TABLE_PERSONS;

    // 按 person_id 查找记录
    const searchRes = await axios.post(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${personTable}/records/search`,
      {
        page_size: 1,
        filter: {
          conjunction: 'and',
          conditions: [{ field_name: 'person_id', operator: 'is', value: [personId] }]
        }
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const items = searchRes.data.data?.items || [];
    if (items.length === 0) {
      return res.status(404).json({ error: '人员记录不存在' });
    }

    const recordId = items[0].record_id;
    await axios.put(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${personTable}/records/${recordId}`,
      { fields: { feishu_open_id: feishuOpenId } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    invalidateTableCache(personTable);

    res.json({ success: true });
  } catch (err) {
    console.error('写回 openId 错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 核心业务接口：获取全部数据 =====
app.get('/api/data/all', authMiddleware, async (req, res) => {
  try {
    const [personsRaw, tasksRaw, ledgerRaw, assetPlanRaw, schedulesRaw] = await Promise.all([
      baseGetAllRecords(process.env.FEISHU_TABLE_PERSONS),
      baseGetAllRecords(process.env.FEISHU_TABLE_TASKS),
      baseGetAllRecords(process.env.FEISHU_TABLE_LEDGER),
      baseGetAllRecords(process.env.FEISHU_TABLE_ASSET_PLAN),
      baseGetAllRecords(process.env.FEISHU_TABLE_SCHEDULES),
    ]);

    // 1. 人员表转换
    const persons = personsRaw.map(item => {
      const f = item.fields;
      return {
        id: f.person_id || item.record_id,
        recordId: item.record_id,
        name: f.name || '',
        roles: extractMultiSelect(f.roles),
        employmentType: extractSelect(f.employment_type),
        salary: f.salary || 0,
        dailySalary: f.daily_salary || 0,
        socialInsurance: f.social_insurance || 0,
        housingFund: f.housing_fund || 0,
        energy: f.energy !== undefined ? f.energy : 1,
        avatar: f.avatar || '',
        feishuOpenId: f.feishu_open_id || '',
        monthlyData: f.monthly_data || '{}',
        isActive: f.is_active !== false,
      };
    });

    // 2. 商单表转换
    const tasks = tasksRaw.map(item => {
      const f = item.fields;
      const brand = extractSelect(f.brand);
      const status = extractSelect(f.status);
      return {
        id: f.task_id || item.record_id,
        recordId: item.record_id,
        brand: brand,
        name: f.name || '',
        startDate: extractDate(f.start_date),
        deliveryDate: extractDate(f.delivery_date),
        totalVideos: f.total_videos || 0,
        status: status || '待排产',
        directorIds: extractLinkIds(f.director),
        assetDesignerIds: extractLinkIds(f.asset_designer),
        aiArtistIds: extractLinkIds(f.ai_artist),
        remark: f.remark || '',
        isDeleted: f.is_deleted === true,
      };
    });

    // 3. 台账表转换 → 按商单分组
    const taskLedger = {};
    ledgerRaw.forEach(item => {
      const f = item.fields;
      const taskLinkIds = extractLinkIds(f.task);
      const taskId = taskLinkIds[0] || '';
      if (!taskId) return;
      // 先存 record_id，后面再按 task_id 映射
      if (!taskLedger[item.record_id]) taskLedger[item.record_id] = [];
      taskLedger[item.record_id].push({
        itemName: f.item_name || '',
        unitPrice: f.unit_price || 0,
        quantity: f.quantity || 0,
        amount: f.amount || (f.unit_price || 0) * (f.quantity || 0),
        remark: f.remark || '',
      });
    });

    // 把台账关联到商单上
    tasks.forEach(task => {
      task.ledger = [];
    });
    // 通过 link 反向查找有点绕，直接再遍历一次 ledgerRaw
    const taskRecordIdToTaskId = {};
    tasks.forEach(t => { taskRecordIdToTaskId[t.recordId] = t.id; });

    ledgerRaw.forEach(item => {
      const f = item.fields;
      const taskRecordIds = extractLinkIds(f.task);
      taskRecordIds.forEach(trId => {
        const taskId = taskRecordIdToTaskId[trId];
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          task.ledger.push({
            itemName: f.item_name || '',
            unitPrice: f.unit_price || 0,
            quantity: f.quantity || 0,
            amount: f.amount !== undefined ? f.amount : (f.unit_price || 0) * (f.quantity || 0),
            remark: f.remark || '',
          });
        }
      });
    });

    // 4. 资产计划表转换 → 按商单分组
    const assetPlanMap = {};
    assetPlanRaw.forEach(item => {
      const f = item.fields;
      const taskRecordIds = extractLinkIds(f.task);
      const taskTrId = taskRecordIds[0];
      const taskId = taskRecordIdToTaskId[taskTrId] || taskTrId;
      const personLinkIds = extractLinkIds(f.person_id);
      const personTrId = personLinkIds[0];

      if (!assetPlanMap[taskId]) assetPlanMap[taskId] = [];
      assetPlanMap[taskId].push({
        id: item.record_id,
        videoIndex: f.video_index || 1,
        assetType: extractSelect(f.asset_type),
        planQty: f.plan_qty || 0,
        planDate: extractDate(f.plan_date),
        made: f.made || 0,
        modified: f.modified || 0,
        delivered: f.delivered || 0,
        editDate: extractDate(f.edit_date),
        personRecordId: personTrId || '',
        personId: '', // 后面映射
        note: f.note || '',
      });
    });

    // 把 personRecordId 映射成 personId
    const personRecordIdToPersonId = {};
    persons.forEach(p => { personRecordIdToPersonId[p.recordId] = p.id; });
    Object.values(assetPlanMap).forEach(list => {
      list.forEach(item => {
        if (item.personRecordId) {
          item.personId = personRecordIdToPersonId[item.personRecordId] || item.personRecordId;
        }
      });
    });

    // 把资产计划挂到商单上
    tasks.forEach(task => {
      task.assetPlan = assetPlanMap[task.id] || [];
    });

    // 商单上的人员关联（record_id → 人员业务 ID），否则前端刷新后匹配不到人员
    tasks.forEach(task => {
      task.directorIds = (task.directorIds || []).map(id => personRecordIdToPersonId[id] || id);
      task.assetDesignerIds = (task.assetDesignerIds || []).map(id => personRecordIdToPersonId[id] || id);
      task.aiArtistIds = (task.aiArtistIds || []).map(id => personRecordIdToPersonId[id] || id);
    });

    // 5. 排产记录表转换
    const schedules = schedulesRaw.map(item => {
      const f = item.fields;
      const personRecordIds = extractLinkIds(f.person);
      const taskRecordIds = extractLinkIds(f.task);
      const personTrId = personRecordIds[0] || '';
      const taskTrId = taskRecordIds[0] || '';

      return {
        id: item.record_id,
        date: extractDate(f.date),
        personId: personRecordIdToPersonId[personTrId] || personTrId,
        personRecordId: personTrId,
        taskId: taskRecordIdToTaskId[taskTrId] || taskTrId,
        taskRecordId: taskTrId,
        role: extractSelect(f.role),
        made: f.made || 0,
        modified: f.modified || 0,
        delivered: f.delivered || 0,
        planned: f.planned || 0,
        madeChar: f.made_char || 0,
        madeScene: f.made_scene || 0,
        madeSb: f.made_sb || 0,
        modifiedChar: f.modified_char || 0,
        modifiedScene: f.modified_scene || 0,
        modifiedSb: f.modified_sb || 0,
        deliveredChar: f.delivered_char || 0,
        deliveredScene: f.delivered_scene || 0,
        deliveredSb: f.delivered_sb || 0,
        isPlanRecord: f.is_plan_record === true,
        note: f.note || '',
      };
    });

    res.json({
      persons,
      tasks,
      schedules,
    });
  } catch (err) {
    console.error('获取全部数据错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：保存排产记录（批量） =====
app.post('/api/data/schedules/batch', authMiddleware, async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: '缺少 records' });
  }

  try {
    const tableId = process.env.FEISHU_TABLE_SCHEDULES;
    const personTable = process.env.FEISHU_TABLE_PERSONS;
    const taskTable = process.env.FEISHU_TABLE_TASKS;

    // 先获取人员和商单的 record_id 映射
    const [personsRaw, tasksRaw] = await Promise.all([
      baseGetAllRecords(personTable),
      baseGetAllRecords(taskTable),
    ]);

    const personIdToRecordId = {};
    personsRaw.forEach(p => {
      const pid = p.fields.person_id || p.record_id;
      personIdToRecordId[pid] = p.record_id;
    });

    const taskIdToRecordId = {};
    tasksRaw.forEach(t => {
      const tid = t.fields.task_id || t.record_id;
      taskIdToRecordId[tid] = t.record_id;
    });

    // 构造飞书记录格式
    const feishuRecords = records.map(r => {
      const fields = {};
      if (r.date) fields.date = toFeishuDate(r.date);
      if (r.personId && personIdToRecordId[r.personId]) {
        fields.person = [personIdToRecordId[r.personId]];
      }
      if (r.taskId && taskIdToRecordId[r.taskId]) {
        fields.task = [taskIdToRecordId[r.taskId]];
      }
      if (r.role) fields.role = r.role;
      fields.made = r.made || 0;
      fields.modified = r.modified || 0;
      fields.delivered = r.delivered || 0;
      fields.planned = r.planned || 0;
      fields.made_char = r.madeChar || 0;
      fields.made_scene = r.madeScene || 0;
      fields.made_sb = r.madeSb || 0;
      fields.modified_char = r.modifiedChar || 0;
      fields.modified_scene = r.modifiedScene || 0;
      fields.modified_sb = r.modifiedSb || 0;
      fields.delivered_char = r.deliveredChar || 0;
      fields.delivered_scene = r.deliveredScene || 0;
      fields.delivered_sb = r.deliveredSb || 0;
      fields.is_plan_record = r.isPlanRecord === true;
      if (r.note) fields.note = r.note;
      return { fields };
    });

    const result = await baseBatchCreate(tableId, feishuRecords);
    res.json({ records: result });
  } catch (err) {
    console.error('批量保存排产错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：更新排产记录 =====
app.put('/api/data/schedules/:recordId', authMiddleware, async (req, res) => {
  const { recordId } = req.params;
  const { fields } = req.body;

  try {
    const tableId = process.env.FEISHU_TABLE_SCHEDULES;
    const feishuFields = {};

    if (fields.date !== undefined) feishuFields.date = toFeishuDate(fields.date);
    if (fields.made !== undefined) feishuFields.made = fields.made;
    if (fields.modified !== undefined) feishuFields.modified = fields.modified;
    if (fields.delivered !== undefined) feishuFields.delivered = fields.delivered;
    if (fields.planned !== undefined) feishuFields.planned = fields.planned;
    if (fields.note !== undefined) feishuFields.note = fields.note;
    if (fields.isPlanRecord !== undefined) feishuFields.is_plan_record = fields.isPlanRecord;
    if (fields.madeChar !== undefined) feishuFields.made_char = fields.madeChar;
    if (fields.madeScene !== undefined) feishuFields.made_scene = fields.madeScene;
    if (fields.madeSb !== undefined) feishuFields.made_sb = fields.madeSb;
    if (fields.modifiedChar !== undefined) feishuFields.modified_char = fields.modifiedChar;
    if (fields.modifiedScene !== undefined) feishuFields.modified_scene = fields.modifiedScene;
    if (fields.modifiedSb !== undefined) feishuFields.modified_sb = fields.modifiedSb;
    if (fields.deliveredChar !== undefined) feishuFields.delivered_char = fields.deliveredChar;
    if (fields.deliveredScene !== undefined) feishuFields.delivered_scene = fields.deliveredScene;
    if (fields.deliveredSb !== undefined) feishuFields.delivered_sb = fields.deliveredSb;

    const token = await getTenantToken();
    const resData = await axios.put(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
      { fields: feishuFields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('更新排产错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：删除排产计划记录（重新排产时清旧数据） =====
app.delete('/api/data/schedules/plan-records', authMiddleware, async (req, res) => {
  try {
    const tableId = process.env.FEISHU_TABLE_SCHEDULES;
    const token = await getTenantToken();

    // 找出所有 is_plan_record = true 的记录
    const searchRes = await axios.post(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/search`,
      {
        page_size: 500,
        filter: {
          conjunction: 'and',
          conditions: [{ field_name: 'is_plan_record', operator: 'is', value: ['true'] }]
        }
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const recordIds = (searchRes.data.data?.items || []).map(i => i.record_id);
    if (recordIds.length === 0) return res.json({ deleted: 0 });

    await baseBatchDelete(tableId, recordIds);
    res.json({ deleted: recordIds.length });
  } catch (err) {
    console.error('删除计划记录错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：保存资产计划记录 =====
app.put('/api/data/asset-plan/:recordId', authMiddleware, async (req, res) => {
  const { recordId } = req.params;
  const { fields } = req.body;

  try {
    const tableId = process.env.FEISHU_TABLE_ASSET_PLAN;
    const personTable = process.env.FEISHU_TABLE_PERSONS;
    const feishuFields = {};

    if (fields.made !== undefined) feishuFields.made = fields.made;
    if (fields.modified !== undefined) feishuFields.modified = fields.modified;
    if (fields.delivered !== undefined) feishuFields.delivered = fields.delivered;
    if (fields.note !== undefined) feishuFields.note = fields.note;
    if (fields.editDate !== undefined) feishuFields.edit_date = toFeishuDate(fields.editDate);

    // personId 转成 link 格式
    if (fields.personId) {
      const personsRaw = await baseGetAllRecords(personTable);
      const person = personsRaw.find(p => (p.fields.person_id || p.record_id) === fields.personId);
      if (person) {
        feishuFields.person_id = [person.record_id];
      }
    }

    const token = await getTenantToken();
    const resData = await axios.put(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
      { fields: feishuFields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('更新资产计划错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：批量创建资产计划记录 =====
app.post('/api/data/asset-plan/batch', authMiddleware, async (req, res) => {
  const { records } = req.body;
  if (!records || !Array.isArray(records)) {
    return res.status(400).json({ error: '缺少 records' });
  }

  try {
    const tableId = process.env.FEISHU_TABLE_ASSET_PLAN;
    const taskTable = process.env.FEISHU_TABLE_TASKS;

    const tasksRaw = await baseGetAllRecords(taskTable);
    const taskIdToRecordId = {};
    tasksRaw.forEach(t => {
      const tid = t.fields.task_id || t.record_id;
      taskIdToRecordId[tid] = t.record_id;
    });

    const feishuRecords = records.map(r => {
      const fields = {};
      if (r.taskId && taskIdToRecordId[r.taskId]) {
        fields.task = [taskIdToRecordId[r.taskId]];
      }
      if (r.videoIndex !== undefined) fields.video_index = r.videoIndex;
      if (r.assetType) fields.asset_type = r.assetType;
      if (r.planQty !== undefined) fields.plan_qty = r.planQty;
      if (r.planDate) fields.plan_date = toFeishuDate(r.planDate);
      fields.made = r.made || 0;
      fields.modified = r.modified || 0;
      fields.delivered = r.delivered || 0;
      if (r.note) fields.note = r.note;
      return { fields };
    });

    const result = await baseBatchCreate(tableId, feishuRecords);
    res.json({ records: result });
  } catch (err) {
    console.error('批量创建资产计划错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：新增/更新商单 =====
app.post('/api/data/tasks', authMiddleware, async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: '缺少 task' });

  try {
    const tableId = process.env.FEISHU_TABLE_TASKS;
    const personTable = process.env.FEISHU_TABLE_PERSONS;
    const token = await getTenantToken();

    const personsRaw = await baseGetAllRecords(personTable);
    const personIdToRecordId = {};
    personsRaw.forEach(p => {
      const pid = p.fields.person_id || p.record_id;
      personIdToRecordId[pid] = p.record_id;
    });

    const fields = {};
    if (task.taskId) fields.task_id = task.taskId;
    if (task.brand) fields.brand = task.brand;
    if (task.name) fields.name = task.name;
    if (task.startDate) fields.start_date = toFeishuDate(task.startDate);
    if (task.deliveryDate) fields.delivery_date = toFeishuDate(task.deliveryDate);
    if (task.totalVideos !== undefined) fields.total_videos = task.totalVideos;
    if (task.status) fields.status = task.status;
    if (task.remark !== undefined) fields.remark = task.remark;
    fields.is_deleted = false;

    // 关联人员
    if (task.directorIds && Array.isArray(task.directorIds)) {
      fields.director = task.directorIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }
    if (task.assetDesignerIds && Array.isArray(task.assetDesignerIds)) {
      fields.asset_designer = task.assetDesignerIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }
    if (task.aiArtistIds && Array.isArray(task.aiArtistIds)) {
      fields.ai_artist = task.aiArtistIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }

    const resData = await axios.post(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('创建商单错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：更新商单 =====
app.put('/api/data/tasks/:recordId', authMiddleware, async (req, res) => {
  const { recordId } = req.params;
  const { fields } = req.body;

  try {
    const tableId = process.env.FEISHU_TABLE_TASKS;
    const personTable = process.env.FEISHU_TABLE_PERSONS;
    const token = await getTenantToken();

    const personsRaw = await baseGetAllRecords(personTable);
    const personIdToRecordId = {};
    personsRaw.forEach(p => {
      const pid = p.fields.person_id || p.record_id;
      personIdToRecordId[pid] = p.record_id;
    });

    const feishuFields = {};
    if (fields.brand !== undefined) feishuFields.brand = fields.brand;
    if (fields.name !== undefined) feishuFields.name = fields.name;
    if (fields.startDate !== undefined) feishuFields.start_date = toFeishuDate(fields.startDate);
    if (fields.deliveryDate !== undefined) feishuFields.delivery_date = toFeishuDate(fields.deliveryDate);
    if (fields.totalVideos !== undefined) feishuFields.total_videos = fields.totalVideos;
    if (fields.status !== undefined) feishuFields.status = fields.status;
    if (fields.remark !== undefined) feishuFields.remark = fields.remark;
    if (fields.isDeleted !== undefined) feishuFields.is_deleted = fields.isDeleted;

    if (fields.directorIds) {
      feishuFields.director = fields.directorIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }
    if (fields.assetDesignerIds) {
      feishuFields.asset_designer = fields.assetDesignerIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }
    if (fields.aiArtistIds) {
      feishuFields.ai_artist = fields.aiArtistIds.filter(id => personIdToRecordId[id]).map(id => personIdToRecordId[id]);
    }

    const resData = await axios.put(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
      { fields: feishuFields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('更新商单错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：永久删除商单（连带台账/资产计划/排产记录） =====
app.delete('/api/data/tasks/:recordId', authMiddleware, async (req, res) => {
  const { recordId } = req.params;
  try {
    const token = await getTenantToken();
    const taskTable = process.env.FEISHU_TABLE_TASKS;

    const relatedTables = [
      process.env.FEISHU_TABLE_SCHEDULES,
      process.env.FEISHU_TABLE_LEDGER,
      process.env.FEISHU_TABLE_ASSET_PLAN,
    ];
    for (const tableId of relatedTables) {
      if (!tableId) continue;
      const raw = await baseGetAllRecords(tableId);
      const ids = raw
        .filter(r => extractLinkIds(r.fields.task).includes(recordId))
        .map(r => r.record_id);
      if (ids.length) await baseBatchDelete(tableId, ids);
    }

    await axios.delete(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${taskTable}/records/${recordId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    invalidateTableCache(taskTable);
    res.json({ success: true });
  } catch (err) {
    console.error('删除商单错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：台账整单同步（先清旧记录，再写入当前台账） =====
app.post('/api/data/ledger/sync', authMiddleware, async (req, res) => {
  const { taskId, items } = req.body;
  if (!taskId || !Array.isArray(items)) {
    return res.status(400).json({ error: '缺少 taskId 或 items' });
  }

  try {
    const tableId = process.env.FEISHU_TABLE_LEDGER;
    const taskTable = process.env.FEISHU_TABLE_TASKS;
    const tasksRaw = await baseGetAllRecords(taskTable);
    const taskRec = tasksRaw.find(t => (t.fields.task_id || t.record_id) === taskId);
    if (!taskRec) return res.status(404).json({ error: '商单不存在' });

    const ledgerRaw = await baseGetAllRecords(tableId);
    const oldIds = ledgerRaw
      .filter(r => extractLinkIds(r.fields.task).includes(taskRec.record_id))
      .map(r => r.record_id);
    if (oldIds.length) await baseBatchDelete(tableId, oldIds);

    const records = items
      .filter(i => i.itemName || i.videoType)
      .map(i => ({
        fields: {
          task: [taskRec.record_id],
          item_name: i.videoType || i.itemName || '',
          unit_price: Number(i.unitPrice) || 0,
          quantity: Number(i.quantity) || 0,
          amount: (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0),
          remark: i.remark || '',
        },
      }));
    if (records.length) await baseBatchCreate(tableId, records);

    res.json({ success: true, count: records.length });
  } catch (err) {
    console.error('同步台账错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：排产计划整单同步（编导/AI制作师/资产设计师，资产明细另存资产计划表） =====
app.post('/api/data/schedules/sync-plan', authMiddleware, async (req, res) => {
  const { taskId, records } = req.body;
  if (!taskId || !Array.isArray(records)) {
    return res.status(400).json({ error: '缺少 taskId 或 records' });
  }

  try {
    const tableId = process.env.FEISHU_TABLE_SCHEDULES;
    const [tasksRaw, personsRaw, schedulesRaw] = await Promise.all([
      baseGetAllRecords(process.env.FEISHU_TABLE_TASKS),
      baseGetAllRecords(process.env.FEISHU_TABLE_PERSONS),
      baseGetAllRecords(tableId),
    ]);

    const taskRec = tasksRaw.find(t => (t.fields.task_id || t.record_id) === taskId);
    if (!taskRec) return res.status(404).json({ error: '商单不存在' });

    const personIdToRecordId = {};
    personsRaw.forEach(p => { personIdToRecordId[p.fields.person_id || p.record_id] = p.record_id; });

    // 清除该商单旧的排产计划记录（保留员工每日实际产出记录）
    const oldIds = schedulesRaw
      .filter(r => extractLinkIds(r.fields.task).includes(taskRec.record_id) && r.fields.is_plan_record === true)
      .map(r => r.record_id);
    if (oldIds.length) await baseBatchDelete(tableId, oldIds);

    const feishuRecords = records
      .map(r => {
        const fields = {
          task: [taskRec.record_id],
          role: r.role,
          planned: Number(r.planned) || 0,
          made: Number(r.made) || 0,
          modified: Number(r.modified) || 0,
          delivered: Number(r.delivered) || 0,
          is_plan_record: true,
        };
        if (r.date) fields.date = toFeishuDate(r.date);
        if (r.personId && personIdToRecordId[r.personId]) {
          fields.person = [personIdToRecordId[r.personId]];
        }
        if (r.note) fields.note = r.note;
        return { fields };
      });
    // 返回创建的记录，前端回填 record_id，避免每日产出编辑时重复新建
    const created = feishuRecords.length ? await baseBatchCreate(tableId, feishuRecords) : [];

    res.json({ success: true, count: feishuRecords.length, records: created });
  } catch (err) {
    console.error('同步排产计划错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：资产计划整单同步 =====
app.post('/api/data/asset-plan/sync', authMiddleware, async (req, res) => {
  const { taskId, records } = req.body;
  if (!taskId || !Array.isArray(records)) {
    return res.status(400).json({ error: '缺少 taskId 或 records' });
  }

  try {
    const tableId = process.env.FEISHU_TABLE_ASSET_PLAN;
    const [tasksRaw, personsRaw, assetRaw] = await Promise.all([
      baseGetAllRecords(process.env.FEISHU_TABLE_TASKS),
      baseGetAllRecords(process.env.FEISHU_TABLE_PERSONS),
      baseGetAllRecords(tableId),
    ]);

    const taskRec = tasksRaw.find(t => (t.fields.task_id || t.record_id) === taskId);
    if (!taskRec) return res.status(404).json({ error: '商单不存在' });

    const personIdToRecordId = {};
    personsRaw.forEach(p => { personIdToRecordId[p.fields.person_id || p.record_id] = p.record_id; });

    const oldIds = assetRaw
      .filter(r => extractLinkIds(r.fields.task).includes(taskRec.record_id))
      .map(r => r.record_id);
    if (oldIds.length) await baseBatchDelete(tableId, oldIds);

    const feishuRecords = records.map(r => {
      const fields = {
        task: [taskRec.record_id],
        video_index: Number(r.videoIndex) || 1,
        asset_type: r.assetType,
        plan_qty: Number(r.planQty) || 0,
        made: Number(r.made) || 0,
        modified: Number(r.modified) || 0,
        delivered: Number(r.delivered) || 0,
        note: r.note || '',
      };
      if (r.planDate) fields.plan_date = toFeishuDate(r.planDate);
      if (r.editDate) fields.edit_date = toFeishuDate(r.editDate);
      if (r.personId && personIdToRecordId[r.personId]) {
        fields.person_id = [personIdToRecordId[r.personId]];
      }
      return { fields };
    });
    if (feishuRecords.length) await baseBatchCreate(tableId, feishuRecords);

    res.json({ success: true, count: feishuRecords.length });
  } catch (err) {
    console.error('同步资产计划错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 写入接口：保存人员 =====
app.post('/api/data/persons', authMiddleware, async (req, res) => {
  const { person } = req.body;
  if (!person) return res.status(400).json({ error: '缺少 person' });

  try {
    const tableId = process.env.FEISHU_TABLE_PERSONS;
    const token = await getTenantToken();

    const fields = {
      person_id: person.id || '',
      name: person.name || '',
      roles: person.roles || [],
      employment_type: person.employmentType || '',
      salary: person.salary || 0,
      daily_salary: person.dailySalary || 0,
      social_insurance: person.socialInsurance || 0,
      housing_fund: person.housingFund || 0,
      energy: person.energy !== undefined ? person.energy : 1,
      avatar: person.avatar || '',
      feishu_open_id: person.feishuOpenId || '',
      monthly_data: person.monthlyData || '{}',
      is_active: person.isActive !== false,
    };

    const resData = await axios.post(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records`,
      { fields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('创建人员错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 更新人员信息（含启用/停用） =====
app.put('/api/data/persons/:recordId', authMiddleware, async (req, res) => {
  const { recordId } = req.params;
  const fields = req.body || {};

  try {
    const tableId = process.env.FEISHU_TABLE_PERSONS;
    const token = await getTenantToken();

    const feishuFields = {};
    if (fields.name !== undefined) feishuFields.name = fields.name;
    if (fields.roles !== undefined) feishuFields.roles = fields.roles;
    if (fields.employmentType !== undefined) feishuFields.employment_type = fields.employmentType;
    if (fields.salary !== undefined) feishuFields.salary = fields.salary;
    if (fields.dailySalary !== undefined) feishuFields.daily_salary = fields.dailySalary;
    if (fields.socialInsurance !== undefined) feishuFields.social_insurance = fields.socialInsurance;
    if (fields.housingFund !== undefined) feishuFields.housing_fund = fields.housingFund;
    if (fields.energy !== undefined) feishuFields.energy = fields.energy;
    if (fields.avatar !== undefined) feishuFields.avatar = fields.avatar;
    if (fields.feishuOpenId !== undefined) feishuFields.feishu_open_id = fields.feishuOpenId;
    if (fields.monthlyData !== undefined) feishuFields.monthly_data = fields.monthlyData;
    if (fields.isActive !== undefined) feishuFields.is_active = fields.isActive;

    if (!Object.keys(feishuFields).length) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    const resData = await axios.put(
      `${FEISHU_BASE}/bitable/v1/apps/${BASE_APP_TOKEN}/tables/${tableId}/records/${recordId}`,
      { fields: feishuFields },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (resData.data.code !== 0) throw new Error(resData.data.msg);
    invalidateTableCache(tableId);
    res.json({ record: resData.data.data.record });
  } catch (err) {
    console.error('更新人员错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 飞书组织：拉取通讯录成员 =====
async function fetchFeishuOrgUsers() {
  const token = await getTenantToken();
  const users = [];
  let pageToken = '';
  do {
    let url = 'https://open.feishu.cn/open-apis/contact/v3/users?page_size=100&department_id=0&user_id_type=open_id';
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.data.code !== 0) {
      const e = new Error(r.data.msg || '拉取通讯录失败');
      e.feishuCode = r.data.code;
      throw e;
    }
    (r.data.data.items || []).forEach(u => {
      users.push({
        openId: u.open_id,
        name: u.name || '',
        email: u.email || '',
        avatar: (u.avatar && (u.avatar.avatar_72 || u.avatar.avatar_240)) || '',
        jobTitle: u.job_title || '',
      });
    });
    pageToken = r.data.data.has_more ? (r.data.data.page_token || '') : '';
  } while (pageToken);
  return users;
}

app.get('/api/org/feishu-users', authMiddleware, async (req, res) => {
  try {
    const users = await fetchFeishuOrgUsers();
    res.json({ users });
  } catch (err) {
    const hint = err.feishuCode === 40004
      ? '应用没有通讯录权限范围：请在开发者后台 → 权限管理 → 通讯录权限范围设为「全部成员」，然后发布版本'
      : err.message;
    console.error('拉取飞书通讯录失败:', err.message);
    res.status(400).json({ error: hint, code: err.feishuCode || null });
  }
});

// ===== 飞书组织：批量导入为系统成员 =====
app.post('/api/org/import', authMiddleware, async (req, res) => {
  const { users } = req.body;
  if (!Array.isArray(users) || !users.length) {
    return res.status(400).json({ error: '缺少 users' });
  }
  try {
    const tableId = process.env.FEISHU_TABLE_PERSONS;
    const existing = await baseGetAllRecords(tableId);

    const normName = v => (v == null ? '' : String(v).trim());
    const existingNames = new Set(existing.map(r => normName(r.fields.name)));
    const existingOpenIds = new Set(
      existing.map(r => normName(r.fields.feishu_open_id)).filter(Boolean)
    );

    // 计算下一个 person_id 序号
    let maxNum = 0;
    existing.forEach(r => {
      const m = /^p(\d+)$/.exec(normName(r.fields.person_id));
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    });

    const toCreate = [];
    users.forEach(u => {
      const name = normName(u.name);
      if (!name) return;
      if (existingNames.has(name)) return;
      if (u.openId && existingOpenIds.has(u.openId)) return;
      maxNum += 1;
      toCreate.push({
        fields: {
          person_id: `p${maxNum}`,
          name,
          roles: [],
          employment_type: '正式员工',
          salary: 0,
          daily_salary: 0,
          social_insurance: 0,
          housing_fund: 0,
          energy: 1,
          avatar: u.avatar || '',
          feishu_open_id: u.openId || '',
          monthly_data: '{}',
          is_active: true,
        },
      });
    });

    if (!toCreate.length) {
      return res.json({ created: 0, skipped: users.length, persons: [] });
    }

    const created = await baseBatchCreate(tableId, toCreate);
    res.json({
      created: created.length,
      skipped: users.length - toCreate.length,
      persons: created.map(r => ({ recordId: r.record_id, ...r.fields })),
    });
  } catch (err) {
    console.error('导入飞书成员失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ===== 调试接口：检查飞书配置和 API 调用 =====
app.get('/api/debug/feishu', async (req, res) => {
  const result = {
    env: {
      hasAppId: !!process.env.FEISHU_APP_ID,
      hasAppSecret: !!process.env.FEISHU_APP_SECRET,
      hasBaseToken: !!process.env.FEISHU_BASE_APP_TOKEN,
    },
    tenantToken: null,
    authenTest: null,
  };

  try {
    const token = await getTenantToken();
    result.tenantToken = token ? `token获取成功: ${token.substring(0, 10)}...` : 'token为空';

    // 测试 authen/v1/access_token
    const authenRes = await axios.post(
      `${FEISHU_BASE}/authen/v1/access_token`,
      { grant_type: 'authorization_code', code: 'debug_test_code' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    result.authenTest = { code: authenRes.data.code, msg: authenRes.data.msg };
  } catch (err) {
    result.error = err.message;
    if (err.response) {
      result.errorStatus = err.response.status;
      result.errorData = err.response.data;
    }
  }

  res.json(result);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  瞬格商单系统已启动                      ║
║  地址: http://localhost:${PORT}              ║
╚══════════════════════════════════════════╝
  `);
});
