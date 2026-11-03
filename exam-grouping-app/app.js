/**
 * ระบบจัดแบ่งกลุ่มสอบเข้า (นักเรียน A-AD & ผู้ปกครอง A1-O3)
 * ไฟล์เดียวครบวงจร (Single-File Self-Contained) เพื่อไม่ให้เกิดปัญหา Cache บน GitHub Pages
 */

const DEFAULT_GSHEET_ID = '1Canvfb_qiRbGdRUuhgXgJsy5q1FwqYmfLdXMqMXXHHM';
const DEFAULT_GSHEET_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_GSHEET_ID}/edit?usp=sharing`;
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyhzx-dlIUtLUeLvSQvfjmhid4v_vHr5i3ZsM_1mX8DtcXSlwzAR5FHxi5DRoHwdmKWHA/exec';
const STORAGE_KEY = 'exam_grouping_app_state_v3';

const CATEGORY_META = {
  general: { label: 'ทั่วไป (สีเทา)', badgeBg: '#64748b', badgeColor: '#fff' },
  sibling: { label: 'พี่น้อง (สีเขียว)', badgeBg: '#16a34a', badgeColor: '#fff' },
  cmu:     { label: 'บุคลากร มช. (สีม่วง)', badgeBg: '#9333ea', badgeColor: '#fff' },
  twin_1:  { label: 'แฝดคู่ที่ 1 (ชมพู)', badgeBg: '#db2777', badgeColor: '#fff' },
  twin_2:  { label: 'แฝดคู่ที่ 2 (ฟ้า)', badgeBg: '#0284c7', badgeColor: '#fff' },
  twin_3:  { label: 'แฝดคู่ที่ 3 (ส้ม)', badgeBg: '#ea580c', badgeColor: '#fff' },
  twin_4:  { label: 'แฝดคู่ที่ 4 (เหลืองทอง)', badgeBg: '#ca8a04', badgeColor: '#fff' },
  twin_5:  { label: 'แฝดคู่ที่ 5 (เขียวมิ้นท์)', badgeBg: '#0d9488', badgeColor: '#fff' },
  twin_6:  { label: 'แฝดคู่ที่ 6 (คราม)', badgeBg: '#4f46e5', badgeColor: '#fff' },
  twin_7:  { label: 'แฝดคู่ที่ 7 (แดงพีช)', badgeBg: '#e11d48', badgeColor: '#fff' },
};

/**
 * แปลงลำดับ 0..29 เป็น A..Z, AA, AB, AC, AD
 */
function indexToAlphaGroup(index) {
  let n = index;
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

function groupNameToOrderNumber(groupName) {
  const clean = String(groupName || '').trim().toUpperCase();
  if (!clean) return null;
  if (/^\d+$/.test(clean)) {
    const n = parseInt(clean, 10);
    return n >= 1 ? n : null;
  }
  if (/^[A-Z]+$/.test(clean)) {
    let val = 0;
    for (let i = 0; i < clean.length; i++) {
      val = val * 26 + (clean.charCodeAt(i) - 64);
    }
    return val;
  }
  return null;
}

function getDefaultStudentGroups1To30() {
  return Array.from({ length: 30 }, (_, i) => indexToAlphaGroup(i)); // A..Z, AA, AB, AC, AD
}

function getStudentGroupsAZ() {
  return Array.from({ length: 26 }, (_, i) => indexToAlphaGroup(i)); // A..Z
}

function getDefaultParentGroups() {
  const groups = [];
  for (let i = 0; i < 15; i++) {
    const letter = String.fromCharCode(65 + i); // A..O
    groups.push(`${letter}1`, `${letter}2`, `${letter}3`);
  }
  return groups;
}

function getEvalRoomInfo(groupName) {
  const num = groupNameToOrderNumber(groupName);
  if (!num || num < 1) return null;
  const roomNumber = ((num - 1) % 6) + 1;
  const roundNumber = Math.floor((num - 1) / 6) + 1;
  return {
    roomNumber,
    roundNumber,
    label: `ห้องประเมิน ${roomNumber} (รอบ ${roundNumber})`
  };
}

let appState = {
  boardMode: 'student',
  subGroupFilter: 'ALL',
  categoryFilter: 'all',
  searchQuery: '',
  gsheetUrl: DEFAULT_GSHEET_URL,
  appsScriptUrl: DEFAULT_APPS_SCRIPT_URL,
  studentGroups: getDefaultStudentGroups1To30(),
  parentGroups: getDefaultParentGroups(),
  cmuSheetCodes: [],
  itpcSheetCodes: [],
  applicants: []
};

let editingApplicantId = null;
let selectedModalCategory = 'general';
let draggedApplicantId = null;
let selectedSwapApplicantId = null;
let cloudSaveTimeout = null;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedSwapApplicantId) {
    clearSwapSelection();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  loadStateFromLocal();
  if (appState.applicants.length > 0) {
    runAutoClassification(false);
  }
  renderAll();

  await syncFromDefaultGoogleSheet(true);
});

function loadStateFromLocal() {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ||
      localStorage.getItem('exam_grouping_app_state_v2') ||
      localStorage.getItem('exam_grouping_app_state_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.applicants)) {
        appState.applicants = parsed.applicants.map(a => {
          if (a.studentGroup && /^\d+$/.test(String(a.studentGroup).trim())) {
            const n = parseInt(a.studentGroup, 10);
            if (n >= 1) a.studentGroup = indexToAlphaGroup(n - 1);
          }
          return a;
        });
      }
      if (parsed && Array.isArray(parsed.studentGroups) && parsed.studentGroups.length > 0) {
        const isNumericList = parsed.studentGroups.every(g => /^\d+$/.test(String(g)));
        const isOld26AZ = parsed.studentGroups.length === 26 && parsed.studentGroups[0] === 'A';
        if (isNumericList || isOld26AZ) {
          appState.studentGroups = getDefaultStudentGroups1To30();
        } else {
          appState.studentGroups = parsed.studentGroups;
        }
      }
      if (parsed && Array.isArray(parsed.parentGroups) && parsed.parentGroups.length > 0) {
        appState.parentGroups = parsed.parentGroups;
      }
      if (parsed && Array.isArray(parsed.cmuSheetCodes)) {
        appState.cmuSheetCodes = parsed.cmuSheetCodes;
      }
      if (parsed && Array.isArray(parsed.itpcSheetCodes)) {
        appState.itpcSheetCodes = parsed.itpcSheetCodes;
      }
      if (parsed && parsed.gsheetUrl) {
        appState.gsheetUrl = parsed.gsheetUrl;
      }
      if (parsed && parsed.appsScriptUrl) {
        appState.appsScriptUrl = parsed.appsScriptUrl;
      }
    }
  } catch (err) {
    console.warn('Could not load local state:', err);
  }

  if (!appState.appsScriptUrl) {
    appState.appsScriptUrl = DEFAULT_APPS_SCRIPT_URL;
  }

  const gsheetInput = document.getElementById('gsheet-url-input');
  if (gsheetInput) gsheetInput.value = appState.gsheetUrl || DEFAULT_GSHEET_URL;

  const gasInput = document.getElementById('apps-script-url-input');
  if (gasInput) gasInput.value = appState.appsScriptUrl || DEFAULT_APPS_SCRIPT_URL;
}

function saveState(triggerCloud = true) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      gsheetUrl: appState.gsheetUrl,
      appsScriptUrl: appState.appsScriptUrl,
      studentGroups: appState.studentGroups,
      parentGroups: appState.parentGroups,
      cmuSheetCodes: appState.cmuSheetCodes,
      itpcSheetCodes: appState.itpcSheetCodes,
      applicants: appState.applicants
    }));
  } catch (err) {
    console.warn('Local storage quota or save issue:', err);
  }

  if (triggerCloud && appState.appsScriptUrl) {
    scheduleCloudSave();
  }
}

// ==================== AUTO-DETECTION: ITPC (SIBLING), CMU (STAFF), & 7 TWIN PAIRS ====================

function normalizeCodeKey(code) {
  const s = String(code ?? '').replace(/[\u200B-\u200D\uFEFF\s]/g, '').trim().toUpperCase();
  if (!s) return '';
  // If purely numeric, strip leading zeros so '001' and '1' match consistently alongside exact string
  if (/^\d+$/.test(s)) {
    return String(parseInt(s, 10));
  }
  return s;
}

function isCmuStaffWorkplace(workText) {
  if (!workText) return false;
  const text = String(workText).trim();
  if (!text) return false;
  if (text.includes('มหาวิทยาลัยเชียงใหม่') || text.includes('ศรีพัฒน์') || text.includes('มช.')) {
    return true;
  }
  const tokens = text.split(/[\s,./()\-_]+/);
  if (tokens.includes('มช')) return true;
  if (/(^|[\s.])มช($|[\s.])/.test(text)) return true;
  return false;
}

/**
 * สกัดนามสกุลของนักเรียนอย่างแม่นยำ รองรับทุกรูปแบบในคอลัมน์ D และ E
 */
function normalizeLastName(lastName, firstName) {
  const cleanStr = (s) =>
    String(s || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const d = cleanStr(firstName);
  const e = cleanStr(lastName);

  if (e && !e.includes(' ')) {
    return e;
  }

  const combined = [d, e]
    .filter(Boolean)
    .join(' ')
    .replace(/^(ด\.ช\.|ด\.ญ\.|ดช\.|ดญ\.|เด็กชาย|เด็กหญิง|นาย|นางสาว|น\.ส\.)\s*/i, '')
    .trim();

  if (!combined) return '';
  const parts = combined.split(/\s+/).filter(Boolean);
  if (parts.length >= 3 && parts[parts.length - 2] === 'ณ') {
    return `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
  }
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return e || '';
}

function normalizeParentNameKey(parentName) {
  const s = String(parentName || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s === '-' || s === 'ไม่มี' || s === 'ไม่ระบุ') return '';
  return s;
}

/**
 * จัดแบ่งสีอัตโนมัติตามเงื่อนไข:
 * 1. เช็คชื่อผู้ปกครองซ้ำกันในชีต data (คอลัมน์ S) -> แฝด 7 คู่ (twin_1 .. twin_7 = 14 คน)
 * 2. หากรหัสชนกับชีต ITPC -> พี่น้อง (สีเขียว) [กรณีชนทั้ง ITPC และ CMU ให้ใช้พี่น้องเป็นหลัก]
 * 3. หากรหัสชนกับชีต CMU -> บุคลากร มช. (สีม่วง)
 * 4. ทั่วไป -> สีเทา
 */
function runAutoClassification(forceRecalculate = false) {
  const itpcSet = new Set((appState.itpcSheetCodes || []).map(normalizeCodeKey).filter(Boolean));
  const cmuSet = new Set((appState.cmuSheetCodes || []).map(normalizeCodeKey).filter(Boolean));

  const parentGroupsMap = {};
  appState.applicants.forEach(app => {
    const pKey = normalizeParentNameKey(app.parentName);
    if (pKey && pKey.length >= 2) {
      if (!parentGroupsMap[pKey]) parentGroupsMap[pKey] = [];
      parentGroupsMap[pKey].push(app);
    }
  });

  const duplicateParentNames = Object.keys(parentGroupsMap)
    .filter(pKey => parentGroupsMap[pKey].length >= 2)
    .sort((a, b) => a.localeCompare(b, 'th'));

  // กำหนดสีคู่แฝด 7 คู่ (twin_1 .. twin_7) เฉพาะคู่ที่มีชื่อผู้ปกครองชื่อเดียวกัน
  const twinColorMap = {};
  duplicateParentNames.slice(0, 7).forEach((pKey, idx) => {
    twinColorMap[pKey] = `twin_${idx + 1}`;
  });

  appState.applicants.forEach(app => {
    const codeKey = normalizeCodeKey(app.code);
    const inItpc = codeKey && itpcSet.has(codeKey);
    const inCmu = (codeKey && cmuSet.has(codeKey)) || (cmuSet.size === 0 && isCmuStaffWorkplace(app.parentWork));

    // บันทึกป้ายกำกับว่าชนชีตไหนบ้างเพื่อแสดงใน Tooltip
    const matchedSheets = [];
    if (inItpc) matchedSheets.push('ITPC (พี่น้อง)');
    if (inCmu) matchedSheets.push('CMU (บุคลากร มช.)');
    app.matchedSheets = matchedSheets;

    if (app.manualCategory && !forceRecalculate) {
      return;
    }

    const pKey = normalizeParentNameKey(app.parentName);
    if (pKey && twinColorMap[pKey]) {
      app.category = twinColorMap[pKey];
    } else if (inItpc) {
      // ชนกับชีต ITPC (หรือชนทั้ง ITPC และ CMU) -> ใช้พี่น้อง (สีเขียว) เป็นหลัก
      app.category = 'sibling';
    } else if (inCmu) {
      // ชนกับชีต CMU -> บุคลากร มช. (สีม่วง)
      app.category = 'cmu';
    } else {
      app.category = 'general';
    }
  });
}

function autoDetectRules() {
  appState.applicants.forEach(a => { a.manualCategory = false; });
  runAutoClassification(true);
  saveState();
  renderAll();
  const sibCount = appState.applicants.filter(a => a.category === 'sibling').length;
  const cmuCount = appState.applicants.filter(a => a.category === 'cmu').length;
  const twinCount = appState.applicants.filter(a => a.category && a.category.startsWith('twin_')).length;
  showToast(`✨ เช็คสถานะแล้ว: พี่น้อง (ITPC) ${sibCount} คน • บุคลากร (CMU) ${cmuCount} คน • แฝด ${twinCount} คน`);
}

// ==================== SEQUENTIAL 30 GROUPS (A-AD) & TWIN SWAP HELPERS ====================

/**
 * เรียงรหัสโดยให้หมวด KS (เช่น 70KS001..70KS205) มาก่อน แล้วตามด้วยหมวด KE (70KE001..70KE204)
 * เพื่อให้ KS001 อยู่กลุ่ม A .. KS030 อยู่กลุ่ม AD แล้ว KS031 วนกลับมากลุ่ม A ตามลำดับจริงในชีต
 */
function getCodeSortRank(code) {
  const s = String(code || '').trim().toUpperCase();
  const numMatch = s.match(/(\d+)$/);
  const num = numMatch ? parseInt(numMatch[1], 10) : 0;
  if (s.includes('KS')) {
    return { tier: 1, num, raw: s };
  }
  if (s.includes('KE')) {
    return { tier: 2, num, raw: s };
  }
  return { tier: 3, num, raw: s };
}

function sortApplicantsKSFirst(list) {
  return [...list].sort((a, b) => {
    const ra = getCodeSortRank(a.code);
    const rb = getCodeSortRank(b.code);
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    if (ra.num !== rb.num) return ra.num - rb.num;
    return ra.raw.localeCompare(rb.raw, 'th', { numeric: true });
  });
}

function assignSequentialRooms1To30(silent = false) {
  if (appState.applicants.length === 0) {
    if (!silent) alert('ยังไม่มีข้อมูลรหัสผู้สมัคร กรุณาซิงค์ข้อมูลจาก Google Sheet ก่อนครับ');
    return;
  }

  const isStudentMode = appState.boardMode === 'student';
  if (isStudentMode) {
    const default30 = getDefaultStudentGroups1To30();
    default30.forEach(g => {
      if (!appState.studentGroups.includes(g)) appState.studentGroups.push(g);
    });
  }

  const targetGroups = isStudentMode ? appState.studentGroups : appState.parentGroups;
  const groupField = isStudentMode ? 'studentGroup' : 'parentGroup';

  const sortedApplicants = sortApplicantsKSFirst(appState.applicants);

  const groupCount = targetGroups.length;
  sortedApplicants.forEach((app, idx) => {
    app[groupField] = targetGroups[idx % groupCount];
  });

  saveState();
  renderAll();
  if (!silent) {
    const firstG = targetGroups[0] || 'A';
    const lastG = targetGroups[groupCount - 1] || 'AD';
    showToast(`⚡ เรียง KS001 ➔ ${firstG}-${lastG} (${groupCount} กลุ่ม) ครบ ${sortedApplicants.length} คนแล้ว • คลิก 2 รหัสเพื่อสลับที่กันได้เลย!`);
  }
}

/**
 * ดึงคู่แฝดทั้ง 7 คู่ให้อยู่กลุ่มเดียวกัน โดยสลับที่กับเด็กทั่วไป (สีเทา) ในกลุ่มนั้นอัตโนมัติ (จำนวนคนต่อกลุ่มคงเดิม)
 */
function pairTwinsTogetherAndSwap() {
  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  let swappedPairs = 0;

  for (let i = 1; i <= 7; i++) {
    const cat = `twin_${i}`;
    const twins = sortApplicantsKSFirst(appState.applicants.filter(a => a.category === cat));
    if (twins.length < 2) continue;

    const t1 = twins[0];
    const targetGroup = t1[groupField];
    if (!targetGroup) continue;

    for (let k = 1; k < twins.length; k++) {
      const t2 = twins[k];
      const oldGroup = t2[groupField];
      if (oldGroup === targetGroup) continue;

      // หาเด็กทั่วไป (สีเทา) ในกลุ่ม targetGroup เพื่อสลับไปอยู่ oldGroup แทน (ทำให้จำนวนคนเท่าเดิม)
      const candidates = appState.applicants.filter(
        a => a[groupField] === targetGroup && a.category === 'general' && a.id !== t1.id && a.id !== t2.id
      );
      if (candidates.length > 0) {
        const swapPartner = candidates[candidates.length - 1];
        swapPartner[groupField] = oldGroup;
        t2[groupField] = targetGroup;
      } else {
        t2[groupField] = targetGroup;
      }
      swappedPairs++;
    }
  }

  saveState();
  renderAll();
  showToast(
    swappedPairs > 0
      ? `👯 รวมคู่แฝดให้อยู่กลุ่มเดียวกันสำเร็จ (${swappedPairs} คู่) โดยสลับที่กับเด็กทั่วไปให้จำนวนคนต่อกลุ่มเท่าเดิม`
      : '👯 คู่แฝดทั้ง 7 คู่อยู่ในกลุ่มเดียวกันเรียบร้อยแล้ว'
  );
}

/**
 * แยกคู่แฝดทั้ง 7 คู่ให้อยู่คนละกลุ่ม โดยสลับที่กับเด็กทั่วไปในกลุ่มถัดไปอัตโนมัติ
 */
function separateTwinsApartAndSwap() {
  const isStudentMode = appState.boardMode === 'student';
  const groupField = isStudentMode ? 'studentGroup' : 'parentGroup';
  const targetGroups = isStudentMode ? appState.studentGroups : appState.parentGroups;
  let separatedCount = 0;

  for (let i = 1; i <= 7; i++) {
    const cat = `twin_${i}`;
    const twins = sortApplicantsKSFirst(appState.applicants.filter(a => a.category === cat));
    if (twins.length < 2) continue;

    const usedGroups = new Set([twins[0][groupField]]);
    for (let k = 1; k < twins.length; k++) {
      const t2 = twins[k];
      const curGroup = t2[groupField];
      if (!curGroup || !usedGroups.has(curGroup)) {
        usedGroups.add(curGroup);
        continue;
      }

      const curIdx = Math.max(0, targetGroups.indexOf(curGroup));
      const nextGroup = targetGroups[(curIdx + 1) % targetGroups.length];
      const candidates = appState.applicants.filter(
        a => a[groupField] === nextGroup && a.category === 'general'
      );
      if (candidates.length > 0) {
        const swapPartner = candidates[candidates.length - 1];
        swapPartner[groupField] = curGroup;
        t2[groupField] = nextGroup;
      } else {
        t2[groupField] = nextGroup;
      }
      usedGroups.add(nextGroup);
      separatedCount++;
    }
  }

  saveState();
  renderAll();
  showToast(
    separatedCount > 0
      ? `↔️ แยกคู่แฝดให้อยู่คนละกลุ่มสำเร็จ (${separatedCount} คู่)`
      : '↔️ คู่แฝดทั้ง 7 คู่อยู่คนละกลุ่มกันทั้งหมดแล้ว'
  );
}

// ==================== GOOGLE SHEET FETCH & PARSING (A, D, E, F, L, S, Y) ====================

function extractSpreadsheetId(urlOrId) {
  if (!urlOrId) return DEFAULT_GSHEET_ID;
  const match = urlOrId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return urlOrId.trim();
}

function extractGid(url) {
  if (!url) return '0';
  const match = url.match(/[#&?]gid=([0-9]+)/);
  return match ? match[1] : '0';
}

/**
 * RFC-4180 UTF-8 CSV Parser (เพื่อไม่ให้เกิดปัญหาภาษาไทยเพี้ยนจาก SheetJS type:'string')
 */
function parseUtf8Csv(csvText) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

async function syncFromDefaultGoogleSheet(silentOnFail = false) {
  const urlInput = document.getElementById('gsheet-url-input');
  const url = (urlInput && urlInput.value.trim()) ? urlInput.value.trim() : (appState.gsheetUrl || DEFAULT_GSHEET_URL);
  await fetchFromGoogleSheetUrl(url, true, silentOnFail);
}

async function fetchFromGoogleSheet() {
  const urlInput = document.getElementById('gsheet-url-input');
  const mergeCheckbox = document.getElementById('merge-mode-checkbox');
  const url = urlInput ? urlInput.value.trim() : DEFAULT_GSHEET_URL;
  const mergeExisting = mergeCheckbox ? mergeCheckbox.checked : true;
  await fetchFromGoogleSheetUrl(url, mergeExisting, false);
}

async function fetchSingleSheetRows(sheetId, sheetName, fallbackGid = null) {
  // 1. Try Google Visualization JSONP by sheetName
  try {
    const rows = await fetchSheetViaJsonp(sheetId, sheetName, fallbackGid);
    if (rows && rows.length > 0) return rows;
  } catch (_) {}

  // 2. Try Google Visualization CSV export by sheetName
  try {
    const param = sheetName
      ? `sheet=${encodeURIComponent(sheetName)}`
      : `gid=${encodeURIComponent(fallbackGid || '0')}`;
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&${param}`;
    const response = await fetch(csvUrl, { cache: 'no-store' });
    if (response.ok) {
      const csvText = await response.text();
      if (csvText && !csvText.trim().startsWith('<!DOCTYPE html')) {
        return parseUtf8Csv(csvText);
      }
    }
  } catch (_) {}

  return null;
}

/**
 * ดึงรหัสผู้สมัครจากชีตย่อย (CMU หรือ ITPC) โดยเทียบกับรหัสที่มีอยู่ในชีต data
 * รองรับทั้งกรณีรหัสอยู่ในคอลัมน์ A หรือคอลัมน์ถัดไป (เช่น คอลัมน์ A เป็นลำดับที่, คอลัมน์ B เป็นรหัส)
 */
function extractMatchingCodesFromSubSheet(subRows, validDataCodeKeys) {
  if (!Array.isArray(subRows) || subRows.length === 0) return [];

  // ตรวจหาว่าคอลัมน์ไหนมีรหัสที่ตรงกับชีต data มากที่สุด หรือมีหัวตารางคำว่า "รหัส"
  const maxCols = Math.min(10, Math.max(...subRows.slice(0, 15).map(r => (Array.isArray(r) ? r.length : 0)), 1));
  let headerCodeCol = -1;

  for (let r = 0; r < Math.min(3, subRows.length); r++) {
    const row = subRows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cellText = String(row[c] || '').trim();
      if (cellText.includes('รหัส') || cellText.includes('เลขที่สมัคร') || cellText.includes('เลขประจำตัว')) {
        headerCodeCol = c;
        break;
      }
    }
    if (headerCodeCol !== -1) break;
  }

  // นับจำนวนรหัสที่ชนกับชีต data ในแต่ละคอลัมน์
  let bestCol = headerCodeCol !== -1 ? headerCodeCol : 0;
  if (headerCodeCol === -1 && validDataCodeKeys && validDataCodeKeys.size > 0) {
    let bestMatches = -1;
    for (let c = 0; c < maxCols; c++) {
      const colHeader = String((subRows[0] && subRows[0][c]) || '').trim();
      if (colHeader === 'ลำดับ' || colHeader === 'ลำดับที่' || colHeader === 'ที่') continue;
      let matchCount = 0;
      for (let r = 0; r < subRows.length; r++) {
        const key = normalizeCodeKey(subRows[r] && subRows[r][c]);
        if (key && validDataCodeKeys.has(key)) matchCount++;
      }
      if (matchCount > bestMatches) {
        bestMatches = matchCount;
        bestCol = c;
      }
    }
  }

  const extracted = new Set();
  for (let r = 0; r < subRows.length; r++) {
    const row = subRows[r];
    if (!Array.isArray(row)) continue;

    // ดึงจากคอลัมน์หลักที่ตรวจพบ
    const primaryKey = normalizeCodeKey(row[bestCol]);
    if (primaryKey && (!validDataCodeKeys || validDataCodeKeys.size === 0 || validDataCodeKeys.has(primaryKey))) {
      extracted.add(primaryKey);
    }

    // และตรวจสอบคอลัมน์ A..D เผื่อบางแถววางรหัสไว้คนละคอลัมน์
    if (validDataCodeKeys && validDataCodeKeys.size > 0) {
      for (let c = 0; c < Math.min(4, row.length); c++) {
        const headerText = String((subRows[0] && subRows[0][c]) || '').trim();
        if (headerText === 'ลำดับ' || headerText === 'ลำดับที่' || headerText === 'ที่') continue;
        const k = normalizeCodeKey(row[c]);
        if (k && validDataCodeKeys.has(k)) {
          extracted.add(k);
        }
      }
    }
  }

  return Array.from(extracted);
}

async function fetchFromGoogleSheetUrl(sheetUrl, mergeExisting = true, silentOnFail = false) {
  const sheetId = extractSpreadsheetId(sheetUrl);
  const gid = extractGid(sheetUrl);
  appState.gsheetUrl = sheetUrl;

  setSyncBadge('saving', '⏳ กำลังดึงชีต data, CMU, ITPC...');
  showSheetStatus('กำลังดึงข้อมูลจากชีต data และตรวจสอบรหัสชนกับชีต CMU (บุคลากร) และ ITPC (พี่น้อง)...', 'info');

  try {
    // 1. ดึงชีต data (หากไม่พบชื่อ data ให้ดึงชีตแรกตาม gid)
    let dataRows = await fetchSingleSheetRows(sheetId, 'data', null);
    if (!dataRows || dataRows.length <= 1) {
      dataRows = await fetchSingleSheetRows(sheetId, null, gid);
    }

    // 2. ดึงชีต CMU, ITPC และ AppState (สถานะการจัดกลุ่มที่แชร์ข้ามเครื่อง) พร้อมกัน
    const [cmuRows, itpcRows, appStateRows] = await Promise.all([
      fetchSingleSheetRows(sheetId, 'CMU', null),
      fetchSingleSheetRows(sheetId, 'ITPC', null),
      fetchSingleSheetRows(sheetId, 'AppState', null)
    ]);

    if (dataRows && dataRows.length > 0) {
      const importedCount = processSheetRows(dataRows, mergeExisting, cmuRows, itpcRows, appStateRows);
      if (importedCount > 0) {
        if (appState.appsScriptUrl) {
          await pullStateFromCloudNow(true);
        }
        const sibCount = appState.applicants.filter(a => a.category === 'sibling').length;
        const cmuCount = appState.applicants.filter(a => a.category === 'cmu').length;
        const twinCount = appState.applicants.filter(a => a.category && a.category.startsWith('twin_')).length;
        setSyncBadge('ok', `☁️ ซิงค์เรียลไทม์ (${importedCount} คน)`);
        showSheetStatus(
          `✅ ดึงชีต data สำเร็จ ${importedCount} คน • พี่น้อง (ITPC): ${sibCount} คน • บุคลากร (CMU): ${cmuCount} คน • แฝด: ${twinCount} คน`,
          'success'
        );
        if (!silentOnFail) {
          showToast(`✅ ซิงค์สำเร็จ ${importedCount} คน (พี่น้อง ITPC ${sibCount} • บุคลากร CMU ${cmuCount} • แฝด ${twinCount})`);
        }
        return;
      }
    }

    throw new Error('ไม่พบแถวข้อมูลรหัสผู้สมัครในชีต data หรือชีตยังไม่ได้เปิดสิทธิ์การเข้าถึง');
  } catch (err) {
    console.warn('Google Sheet fetch notice:', err);
    setSyncBadge('ready', '☁️ เชื่อมต่อ Google Sheet');
    showSheetStatus(
      '⚠️ ไม่สามารถดึงข้อมูลอัตโนมัติได้ (ตรวจสอบว่าตั้งค่าแชร์ Google Sheet เป็น "ทุกคนที่มีลิงก์ดูได้" หรือยัง) หรืออัปโหลดไฟล์ Excel ด้านล่างแทนได้ครับ',
      'error'
    );

    if (appState.applicants.length === 0) {
      loadSampleData(false);
      if (!silentOnFail) {
        showToast('💡 โหลดข้อมูลตัวอย่างให้ทดลองใช้งานก่อน (สามารถกดซิงค์ Google Sheet ได้ตลอดเวลา)');
      }
    }
  }
}

function colIdToIndex(colId, fallbackIdx) {
  if (!colId || typeof colId !== 'string') return fallbackIdx;
  const clean = colId.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(clean)) return fallbackIdx;
  let idx = 0;
  for (let i = 0; i < clean.length; i++) {
    idx = idx * 26 + (clean.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function fetchSheetViaJsonp(sheetId, sheetName = 'data', gid = '0') {
  return new Promise((resolve, reject) => {
    const callbackName = 'gvizCallback_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('หมดเวลาเชื่อมต่อ Google Sheet'));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = function(response) {
      cleanup();
      if (!response || response.status === 'error' || !response.table) {
        reject(new Error('Google Sheet ตอบกลับผิดพลาด'));
        return;
      }
      const cols = response.table.cols || [];
      const tableRows = response.table.rows || [];
      const result = [];

      // ใช้ col.id (เช่น A=0, D=3, E=4, F=5, L=11, S=18, Y=24) เพื่อไม่ให้คอลัมน์เลื่อนเมื่อมีคอลัมน์ว่างในชีต
      const colIndices = cols.map((c, idx) => colIdToIndex(c && c.id, idx));
      const maxColIdx = Math.max(26, ...colIndices, 0);

      const headerRow = new Array(maxColIdx + 1).fill('');
      cols.forEach((c, idx) => {
        if (c && c.label) {
          headerRow[colIndices[idx]] = String(c.label);
        }
      });
      if (headerRow.some(h => h !== '')) {
        result.push(headerRow);
      }

      tableRows.forEach(r => {
        const cells = r.c || [];
        const rowArr = new Array(maxColIdx + 1).fill('');
        for (let i = 0; i < cells.length; i++) {
          const targetIdx = colIndices[i] !== undefined ? colIndices[i] : i;
          const cell = cells[i];
          if (!cell) {
            rowArr[targetIdx] = '';
          } else if (cell.f !== undefined && cell.f !== null && String(cell.f).trim() !== '') {
            rowArr[targetIdx] = String(cell.f);
          } else if (cell.v !== undefined && cell.v !== null) {
            rowArr[targetIdx] = String(cell.v);
          } else {
            rowArr[targetIdx] = '';
          }
        }
        result.push(rowArr);
      });

      resolve(result);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('ไม่สามารถโหลดสคริปต์ Google Sheet'));
    };

    const sheetParam = sheetName
      ? `&sheet=${encodeURIComponent(sheetName)}`
      : `&gid=${encodeURIComponent(gid || '0')}`;
    script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json;responseHandler:${callbackName}${sheetParam}`;
    document.body.appendChild(script);
  });
}

function processSheetRows(rows, mergeExisting = true, cmuRows = null, itpcRows = null, appStateRows = null) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const existingByCode = {};
  appState.applicants.forEach(a => {
    existingByCode[String(a.code).trim()] = a;
  });

  const firstRowStr = rows[0].map(c => String(c || '').trim()).join('|');
  const isExportedSummaryFormat =
    firstRowStr.includes('รหัสผู้สมัคร') &&
    firstRowStr.includes('กลุ่มนักเรียน') &&
    rows[0].length <= 13;

  const newApplicants = [];
  let count = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const rawCode = String(row[0] !== undefined ? row[0] : '').trim();
    if (!rawCode) continue;

    const lowerCode = rawCode.toLowerCase();
    if (
      rawCode.includes('รหัส') ||
      rawCode.includes('ลำดับ') ||
      lowerCode === 'id' ||
      lowerCode === 'code' ||
      lowerCode === 'no' ||
      lowerCode === 'no.'
    ) {
      continue;
    }

    let firstName = '';
    let lastName = '';
    let nickname = '';
    let school = '';
    let parentName = '';
    let parentWork = '';
    let importedCategory = '';
    let importedStudentGroup = '';
    let importedParentGroup = '';
    let importedNote = '';

    if (isExportedSummaryFormat) {
      firstName = String(row[1] || '').trim();
      lastName = String(row[2] || '').trim();
      nickname = String(row[3] || '').trim();
      school = String(row[4] || '').trim();
      parentName = String(row[5] || '').trim();
      parentWork = String(row[6] || '').trim();
      importedCategory = parseCategoryLabel(String(row[7] || '').trim());
      importedStudentGroup = String(row[8] || '').trim();
      importedParentGroup = String(row[10] !== undefined ? row[10] : (row[9] || '')).trim();
      importedNote = String(row[11] !== undefined ? row[11] : (row[10] || '')).trim();
    } else {
      firstName = String(row[3] !== undefined ? row[3] : '').trim();
      lastName = String(row[4] !== undefined ? row[4] : '').trim();
      nickname = String(row[5] !== undefined ? row[5] : '').trim();
      school = String(row[11] !== undefined ? row[11] : '').trim();
      parentName = String(row[18] !== undefined ? row[18] : '').trim();
      parentWork = String(row[24] !== undefined ? row[24] : '').trim();

      if (firstName === 'ชื่อ' || firstName === 'ชื่อนักเรียน' || school === 'โรงเรียน' || lastName === 'นามสกุล') {
        continue;
      }
    }

    const prev = existingByCode[rawCode];
    const keepManual = importedCategory ? true : (mergeExisting && prev ? !!prev.manualCategory : false);

    const item = {
      id: prev ? prev.id : ('app_' + Date.now() + '_' + i),
      code: rawCode,
      firstName: firstName || (prev ? prev.firstName : ''),
      lastName: lastName || (prev ? prev.lastName : ''),
      nickname: nickname || (prev ? prev.nickname : ''),
      school: school || (prev ? prev.school : ''),
      parentName: parentName || (prev ? prev.parentName : ''),
      parentWork: parentWork || (prev ? prev.parentWork : ''),
      category: importedCategory || (keepManual && prev ? prev.category : ''),
      manualCategory: keepManual,
      studentGroup: importedStudentGroup || (mergeExisting && prev ? prev.studentGroup : ''),
      parentGroup: importedParentGroup || (mergeExisting && prev ? prev.parentGroup : ''),
      note: importedNote || (mergeExisting && prev ? prev.note : '')
    };

    if (item.studentGroup && !appState.studentGroups.includes(item.studentGroup)) {
      appState.studentGroups.push(item.studentGroup);
    }
    if (item.parentGroup && !appState.parentGroups.includes(item.parentGroup)) {
      appState.parentGroups.push(item.parentGroup);
    }

    newApplicants.push(item);
    count++;
  }

  if (count > 0) {
    appState.applicants = newApplicants;

    const validDataCodeKeys = new Set(newApplicants.map(a => normalizeCodeKey(a.code)).filter(Boolean));
    if (Array.isArray(cmuRows) && cmuRows.length > 0) {
      appState.cmuSheetCodes = extractMatchingCodesFromSubSheet(cmuRows, validDataCodeKeys);
    }
    if (Array.isArray(itpcRows) && itpcRows.length > 0) {
      appState.itpcSheetCodes = extractMatchingCodesFromSubSheet(itpcRows, validDataCodeKeys);
    }

    runAutoClassification(false);

    // นำสถานะการจัดกลุ่มล่าสุดจากชีต AppState มาใช้ก่อนเสมอ
    if (Array.isArray(appStateRows) && appStateRows.length > 0) {
      applyAppStateSheetRows(appStateRows);
    }

    const hasAnyStudentGroup = appState.applicants.some(a => a.studentGroup && a.studentGroup.trim() !== '');
    if (!hasAnyStudentGroup) {
      assignSequentialRooms1To30(true);
    } else {
      saveState(false);
      renderAll();
    }
  }

  return count;
}

function parseCategoryLabel(label) {
  if (!label) return '';
  if (label.includes('พี่น้อง') || label === 'sibling') return 'sibling';
  if (label.includes('มช') || label.includes('ศรีพัฒน์') || label === 'cmu') return 'cmu';
  for (let i = 1; i <= 7; i++) {
    if (label.includes(`คู่ที่ ${i}`) || label.includes(`แฝด ${i}`) || label === `twin_${i}`) {
      return `twin_${i}`;
    }
  }
  if (label.includes('ทั่วไป') || label === 'general') return 'general';
  return '';
}

// ==================== SAMPLE DATA ====================

function loadSampleData(notify = true) {
  const sampleRecords = [
    { code: '67001', d: 'ด.ช. ภัทรพล', e: 'วงศ์สวัสดิ์', f: 'ภัทร', l: 'รร.อนุบาลเชียงใหม่', s: 'นาย สมชาย วงศ์สวัสดิ์', y: 'บริษัท เชียงใหม่วิศวกรรม จำกัด' },
    { code: '67002', d: 'ด.ช. ภัทรวรรธน์', e: 'วงศ์สวัสดิ์', f: 'ภีม', l: 'รร.อนุบาลเชียงใหม่', s: 'นาย สมชาย วงศ์สวัสดิ์', y: 'บริษัท เชียงใหม่วิศวกรรม จำกัด' },

    { code: '67003', d: 'ด.ญ. พิมพ์ลภัส', e: 'เจริญสุข', f: 'พิม', l: 'รร.เรยีนาเชลีวิทยาลัย', s: 'นาง พิมพ์ใจ เจริญสุข', y: 'คณะแพทยศาสตร์ มหาวิทยาลัยเชียงใหม่' },
    { code: '67004', d: 'ด.ญ. พิมพ์ชนก', e: 'เจริญสุข', f: 'แพรว', l: 'รร.เรยีนาเชลีวิทยาลัย', s: 'นาง พิมพ์ใจ เจริญสุข', y: 'คณะแพทยศาสตร์ มหาวิทยาลัยเชียงใหม่' },

    { code: '67005', d: 'ด.ช. คุณานนต์', e: 'รัตนากร', f: 'คูณ', l: 'รร.มงฟอร์ตวิทยาลัย', s: 'นาย วรพจน์ รัตนากร', y: 'ธุรกิจส่วนตัว' },
    { code: '67006', d: 'ด.ช. คุณากร', e: 'รัตนากร', f: 'คิน', l: 'รร.มงฟอร์ตวิทยาลัย', s: 'นาย วรพจน์ รัตนากร', y: 'ธุรกิจส่วนตัว' },

    { code: '67007', d: 'ด.ญ. ณัฐธิดา', e: 'อินทรโชติ', f: 'น้ำเหนือ', l: 'รร.ปรินส์รอยแยลส์วิทยาลัย', s: 'นพ. ณัฐพล อินทรโชติ', y: 'ศูนย์ความเป็นเลิศทางการแพทย์ ศรีพัฒน์' },
    { code: '67008', d: 'ด.ญ. ณัฐณิชา', e: 'อินทรโชติ', f: 'น้ำหนาว', l: 'รร.ปรินส์รอยแยลส์วิทยาลัย', s: 'นพ. ณัฐพล อินทรโชติ', y: 'ศูนย์ความเป็นเลิศทางการแพทย์ ศรีพัฒน์' },

    { code: '67009', d: 'ด.ช. ธนดล', e: 'กิตติขจร', f: 'ต้นน้ำ', l: 'รร.ดาราวิทยาลัย', s: 'นาง กัลยา กิตติขจร', y: 'ธนาคารกรุงไทย สาขาเชียงใหม่' },
    { code: '67010', d: 'ด.ญ. ธนพร', e: 'กิตติขจร', f: 'ปลายฟ้า', l: 'รร.ดาราวิทยาลัย', s: 'นาง กัลยา กิตติขจร', y: 'ธนาคารกรุงไทย สาขาเชียงใหม่' },

    { code: '67011', d: 'ด.ญ. อรปรียา', e: 'สุวรรณภูมิ', f: 'เอม', l: 'รร.วารีเชียงใหม่', s: 'นาย อานนท์ สุวรรณภูมิ', y: 'สถาปนิกอิสระ' },
    { code: '67012', d: 'ด.ญ. อรจิรา', e: 'สุวรรณภูมิ', f: 'ออม', l: 'รร.วารีเชียงใหม่', s: 'นาย อานนท์ สุวรรณภูมิ', y: 'สถาปนิกอิสระ' },

    { code: '67013', d: 'ด.ช. ปุณณวิช', e: 'อัครเดช', f: 'ปุณณ์', l: 'รร.ช่องฟ้าซินเซิงวาณิชบำรุง', s: 'นางสาว สุดารัตน์ อัครเดช', y: 'การไฟฟ้าส่วนภูมิภาค' },
    { code: '67014', d: 'ด.ช. ปุณณภพ', e: 'อัครเดช', f: 'ปราบ', l: 'รร.ช่องฟ้าซินเซิงวาณิชบำรุง', s: 'นางสาว สุดารัตน์ อัครเดช', y: 'การไฟฟ้าส่วนภูมิภาค' },

    { code: '67015', d: 'ด.ช. กิตติภพ', e: 'แสนทวีสุข', f: 'กิต', l: 'รร.อนุบาลเชียงใหม่', s: 'รศ.ดร. ธีรพงศ์ แสนทวีสุข', y: 'คณะวิศวกรรมศาสตร์ มหาวิทยาลัยเชียงใหม่' },
    { code: '67016', d: 'ด.ญ. ชนัญญา', e: 'ศรีวิชัย', f: 'เชอรี่', l: 'รร.พุทธิโสภณ', s: 'นาง มยุรี ศรีวิชัย', y: 'โรงพยาบาลมหาราชนครเชียงใหม่ (มช.)' },
    { code: '67017', d: 'ด.ช. ภูมิภัทร', e: 'นันทขว้าง', f: 'ภูมิ', l: 'รร.คำเที่ยงอนุสสรณ์', s: 'นาย เอกชัย นันทขว้าง', y: 'สำนักบริการเทคโนโลยีสารสนเทศ มช' },
    { code: '67018', d: 'ด.ญ. ลลิตา', e: 'ไชยวงศ์', f: 'ลิน', l: 'รร.เรยีนาเชลีวิทยาลัย', s: 'พญ. วรัญญา ไชยวงศ์', y: 'คลินิกพิเศษ ศรีพัฒน์' },

    { code: '67019', d: 'ด.ช. นภัสกร', e: 'ใจดี', f: 'นาย', l: 'รร.ปรินส์รอยแยลส์วิทยาลัย', s: 'นาย สมศักดิ์ ใจดี', y: 'รับราชการครู', cat: 'sibling', note: 'มีพี่เรียนอยู่ชั้น ป.4' },
    { code: '67020', d: 'ด.ญ. กัญญาณัฐ', e: 'ทองคำ', f: 'แก้ม', l: 'รร.ดาราวิทยาลัย', s: 'นาง ศิริพร ทองคำ', y: 'ค้าขายส่วนตัว' },
    { code: '67021', d: 'ด.ช. ศุภณัฐ', e: 'คำเมือง', f: 'เจมส์', l: 'รร.มงฟอร์ตวิทยาลัย', s: 'นาย ประเสริฐ คำเมือง', y: 'ท่าอากาศยานเชียงใหม่' },
    { code: '67022', d: 'ด.ญ. ปภาวรินท์', e: 'บุญมี', f: 'ปริม', l: 'รร.อนุบาลเชียงใหม่', s: 'นาง นงลักษณ์ บุญมี', y: 'สำนักงานจังหวัดเชียงใหม่' }
  ];

  appState.applicants = sampleRecords.map((r, idx) => ({
    id: 'sample_' + (idx + 1),
    code: r.code,
    firstName: r.d,
    lastName: r.e,
    nickname: r.f,
    school: r.l,
    parentName: r.s,
    parentWork: r.y,
    category: r.cat || 'general',
    manualCategory: !!r.cat,
    studentGroup: '',
    parentGroup: '',
    note: r.note || ''
  }));

  runAutoClassification(false);
  saveState();
  renderAll();
  if (notify) {
    closeModal('gsheet-modal');
    showToast('✨ โหลดข้อมูลตัวอย่าง 22 รหัส (พร้อมแฝด 7 คู่ และบุคลากร มช.) เรียบร้อยแล้ว');
  }
}

// ==================== RENDERING UI ====================

function setElText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderAll() {
  try { renderHeaderSummaries(); } catch (e) { console.error(e); }
  try { renderFilterCounts(); } catch (e) { console.error(e); }
  try { renderBoardHeaderAndTabs(); } catch (e) { console.error(e); }
  try { renderSwapActionBar(); } catch (e) { console.error(e); }
  try { renderUnassignedPool(); } catch (e) { console.error(e); }
  try { renderGroupsGrid(); } catch (e) { console.error(e); }
}

function renderSwapActionBar() {
  const bar = document.getElementById('swap-action-bar');
  const textEl = document.getElementById('swap-bar-text');
  if (!bar || !textEl) return;

  if (!selectedSwapApplicantId) {
    bar.classList.add('hidden');
    return;
  }

  const app = appState.applicants.find(a => a.id === selectedSwapApplicantId);
  if (!app) {
    selectedSwapApplicantId = null;
    bar.classList.add('hidden');
    return;
  }

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  const curGroup = app[groupField] || 'ยังไม่จัดกลุ่ม';
  const fullName = [app.firstName, app.lastName].filter(Boolean).join(' ') || '-';
  const nick = app.nickname ? ` (${app.nickname})` : '';

  textEl.innerHTML = `
    <span>📌 กำลังเลือก: <strong>${escapeHtml(app.code)}</strong> — ${escapeHtml(fullName)}${escapeHtml(nick)} [กลุ่ม <strong>${escapeHtml(curGroup)}</strong>]</span>
    <span style="background:rgba(255,255,255,0.18);padding:0.15rem 0.55rem;border-radius:6px;">👉 คลิกที่รหัสอื่นเพื่อ <strong>สลับกลุ่มทันที</strong> • หรือคลิกที่หัวกล่องกลุ่มเพื่อ <strong>ย้ายเข้ากลุ่มนั้น</strong></span>
  `;
  bar.classList.remove('hidden');
}

function clearSwapSelection() {
  selectedSwapApplicantId = null;
  renderAll();
}

function openEditForSelectedSwap() {
  if (!selectedSwapApplicantId) return;
  const id = selectedSwapApplicantId;
  selectedSwapApplicantId = null;
  renderAll();
  openEditApplicantModal(id);
}

function handleChipClickForSwap(applicant) {
  // 1. หากยังไม่ได้เลือกรหัสใด -> เลือกรหัสนี้เป็นตัวตั้งต้นเพื่อรอสลับ
  if (!selectedSwapApplicantId) {
    selectedSwapApplicantId = applicant.id;
    renderAll();
    return;
  }

  // 2. หากคลิกซ้ำที่รหัสเดิม -> เปิดหน้าต่างแก้ไขสี/ข้อมูลของรหัสนี้
  if (selectedSwapApplicantId === applicant.id) {
    selectedSwapApplicantId = null;
    renderAll();
    openEditApplicantModal(applicant.id);
    return;
  }

  // 3. หากคลิกที่รหัสอื่น -> สลับกลุ่มระหว่าง 2 รหัสนี้ทันที!
  const sourceApp = appState.applicants.find(a => a.id === selectedSwapApplicantId);
  selectedSwapApplicantId = null;
  if (!sourceApp) {
    renderAll();
    return;
  }

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  const g1 = sourceApp[groupField] || '';
  const g2 = applicant[groupField] || '';

  sourceApp[groupField] = g2;
  applicant[groupField] = g1;

  saveState();
  renderAll();
  showToast(`🔄 สลับกลุ่มสำเร็จ: ${sourceApp.code} (${g1 || 'ยังไม่จัด'} ➔ ${g2 || 'ยังไม่จัด'}) สลับกับ ${applicant.code} (${g2 || 'ยังไม่จัด'} ➔ ${g1 || 'ยังไม่จัด'})`);
}

function handleGroupHeaderClick(targetGroupName) {
  if (!selectedSwapApplicantId) return;
  const sourceApp = appState.applicants.find(a => a.id === selectedSwapApplicantId);
  selectedSwapApplicantId = null;
  if (!sourceApp) {
    renderAll();
    return;
  }

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  const oldGroup = sourceApp[groupField] || 'ยังไม่จัด';
  sourceApp[groupField] = targetGroupName;

  saveState();
  renderAll();
  showToast(`➡️ ย้ายรหัส ${sourceApp.code} จาก ${oldGroup} ไปยัง ${targetGroupName ? 'กลุ่ม ' + targetGroupName : 'ช่องยังไม่ได้จัดกลุ่ม'} เรียบร้อยแล้ว`);
}

function renderHeaderSummaries() {
  const total = appState.applicants.length;
  const studentAssigned = appState.applicants.filter(a => a.studentGroup && a.studentGroup.trim() !== '').length;
  const parentAssigned = appState.applicants.filter(a => a.parentGroup && a.parentGroup.trim() !== '').length;

  setElText('student-board-summary', `จัดกลุ่มแล้ว ${studentAssigned} / ${total} คน`);
  setElText('parent-board-summary', `จัดกลุ่มแล้ว ${parentAssigned} / ${total} คน`);

  document.getElementById('tab-student')?.classList.toggle('active', appState.boardMode === 'student');
  document.getElementById('tab-parent')?.classList.toggle('active', appState.boardMode === 'parent');
}

function renderFilterCounts() {
  const allCount = appState.applicants.length;
  const genCount = appState.applicants.filter(a => a.category === 'general').length;
  const sibCount = appState.applicants.filter(a => a.category === 'sibling').length;
  const cmuCount = appState.applicants.filter(a => a.category === 'cmu').length;
  const twinsCount = appState.applicants.filter(a => a.category && a.category.startsWith('twin_')).length;

  setElText('count-all', allCount);
  setElText('count-general', genCount);
  setElText('count-sibling', sibCount);
  setElText('count-cmu', cmuCount);
  setElText('count-twins', twinsCount);

  document.querySelectorAll('#category-filters .chip-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === appState.categoryFilter);
  });

  document.querySelectorAll('.twins-legend .twin-pill').forEach(btn => {
    btn.classList.toggle('active-twin-filter', btn.dataset.filter === appState.categoryFilter);
  });
}

function renderBoardHeaderAndTabs() {
  const banner = document.getElementById('board-banner');
  const title = document.getElementById('board-title');
  const note = document.getElementById('board-schedule-note');
  const modeLabel = document.getElementById('current-mode-group-label');

  if (appState.boardMode === 'student') {
    const firstG = appState.studentGroups[0] || 'A';
    const lastG = appState.studentGroups[appState.studentGroups.length - 1] || 'AD';
    if (banner) banner.className = 'board-banner student-mode-banner';
    if (title) title.textContent = `👧👦 กระดานจัดกลุ่มสอบนักเรียน (${appState.studentGroups.length} กลุ่ม: ${firstG} - ${lastG} • 6 ห้องประเมิน)`;
    if (note) note.textContent = `เรียง ${firstG} - ${lastG} (ห้องละ 12-14 คน) • ลากรหัสไปวางกลุ่มอื่น หรือลากทับรหัสอื่นเพื่อสลับกลุ่มกันได้ทันที`;
    if (modeLabel) modeLabel.textContent = `นักเรียน ${firstG}-${lastG}`;
    renderSubGroupTabsForStudent();
  } else {
    if (banner) banner.className = 'board-banner parent-mode-banner';
    if (title) title.textContent = `👨‍👩‍👧 กระดานจัดกลุ่มผู้ปกครอง (${appState.parentGroups.length} กลุ่ม)`;
    if (note) note.textContent = 'วัน/เวลาสอบผู้ปกครอง • ลากรหัสไปวางกลุ่มอื่น หรือลากทับรหัสอื่นเพื่อสลับกลุ่มได้ทันที';
    if (modeLabel) modeLabel.textContent = 'ผู้ปกครอง A1-O3';
    renderSubGroupTabsForParent();
  }
}

function renderSubGroupTabsForStudent() {
  const bar = document.getElementById('parent-letter-tabs') || document.getElementById('sub-group-tabs');
  if (!bar) return;
  bar.classList.remove('hidden');
  let html = `<button class="letter-tab ${appState.subGroupFilter === 'ALL' ? 'active' : ''}" onclick="setSubGroupFilter('ALL')">แสดงทุกกลุ่ม (${appState.studentGroups.length} กลุ่ม)</button>`;
  for (let r = 1; r <= 6; r++) {
    const active = appState.subGroupFilter === `ROOM_${r}` ? 'active' : '';
    const roomGroups = appState.studentGroups.filter(g => {
      const info = getEvalRoomInfo(g);
      return info && info.roomNumber === r;
    });
    if (roomGroups.length > 0) {
      html += `<button class="letter-tab ${active}" onclick="setSubGroupFilter('ROOM_${r}')">🚪 ห้องประเมินที่ ${r} (กลุ่ม ${roomGroups.join(', ')})</button>`;
    }
  }
  bar.innerHTML = html;
}

function renderSubGroupTabsForParent() {
  const bar = document.getElementById('parent-letter-tabs') || document.getElementById('sub-group-tabs');
  if (!bar) return;
  bar.classList.remove('hidden');
  const prefixes = [];
  appState.parentGroups.forEach(g => {
    const match = g.match(/^([A-Za-zก-ฮ]+)/);
    const p = match ? match[1].toUpperCase() : 'อื่นๆ';
    if (!prefixes.includes(p)) prefixes.push(p);
  });

  let html = `<button class="letter-tab ${appState.subGroupFilter === 'ALL' ? 'active' : ''}" onclick="setSubGroupFilter('ALL')">แสดงทุกหมวด (${appState.parentGroups.length})</button>`;
  prefixes.forEach(p => {
    const active = appState.subGroupFilter === p ? 'active' : '';
    html += `<button class="letter-tab ${active}" onclick="setSubGroupFilter('${p}')">หมวด ${p}</button>`;
  });
  bar.innerHTML = html;
}

function matchesSearchAndCategory(applicant) {
  const cat = applicant.category || 'general';
  if (appState.categoryFilter !== 'all') {
    if (appState.categoryFilter === 'twins') {
      if (!cat.startsWith('twin_')) return false;
    } else if (cat !== appState.categoryFilter) {
      return false;
    }
  }

  if (appState.searchQuery) {
    const q = appState.searchQuery.toLowerCase();
    const haystack = [
      applicant.code,
      applicant.firstName,
      applicant.lastName,
      applicant.nickname,
      applicant.school,
      applicant.parentName,
      applicant.parentWork,
      applicant.note
    ].join(' ').toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return true;
}

function createApplicantChipElement(applicant) {
  const chip = document.createElement('div');
  const catClass = `cat-${applicant.category || 'general'}`;
  const swapClass = selectedSwapApplicantId === applicant.id ? ' selected-for-swap' : '';
  chip.className = `code-chip ${catClass}${swapClass}`;
  chip.draggable = true;
  chip.dataset.id = applicant.id;
  chip.textContent = applicant.code;

  chip.addEventListener('dragstart', (e) => {
    draggedApplicantId = applicant.id;
    chip.classList.add('dragging');
    hideHoverTooltip();
    e.dataTransfer.setData('text/plain', applicant.id);
    e.dataTransfer.effectAllowed = 'move';
  });

  chip.addEventListener('dragend', () => {
    chip.classList.remove('dragging');
    draggedApplicantId = null;
    document.querySelectorAll('.code-chip.swap-target').forEach(el => el.classList.remove('swap-target'));
  });

  // Drop directly onto another applicant chip to SWAP their groups!
  chip.addEventListener('dragover', (e) => {
    if (draggedApplicantId && draggedApplicantId !== applicant.id) {
      e.preventDefault();
      e.stopPropagation();
      chip.classList.add('swap-target');
    }
  });

  chip.addEventListener('dragleave', () => {
    chip.classList.remove('swap-target');
  });

  chip.addEventListener('drop', (e) => {
    chip.classList.remove('swap-target');
    const sourceId = e.dataTransfer.getData('text/plain') || draggedApplicantId;
    if (!sourceId || sourceId === applicant.id) return;

    e.preventDefault();
    e.stopPropagation();

    const sourceApp = appState.applicants.find(a => a.id === sourceId);
    if (!sourceApp) return;

    const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
    const tempGroup = sourceApp[groupField] || '';
    sourceApp[groupField] = applicant[groupField] || '';
    applicant[groupField] = tempGroup;
    selectedSwapApplicantId = null;

    saveState();
    renderAll();
    showToast(`🔄 สลับกลุ่มระหว่างรหัส ${sourceApp.code} กับ ${applicant.code} เรียบร้อยแล้ว`);
  });

  chip.addEventListener('mouseenter', (e) => {
    showHoverTooltip(e, applicant);
  });

  chip.addEventListener('mousemove', (e) => {
    moveHoverTooltip(e);
  });

  chip.addEventListener('mouseleave', () => {
    hideHoverTooltip();
  });

  // คลิก 1 ครั้งเพื่อเลือกสลับ (คลิกที่รหัสอื่นเพื่อสลับกลุ่มทันที หรือคลิกซ้ำรหัสเดิมเพื่อแก้สี/ข้อมูล)
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    hideHoverTooltip();
    handleChipClickForSwap(applicant);
  });

  // คลิกขวาเพื่อเปิดหน้าต่างแก้สี/ข้อมูลโดยตรงได้ทันที
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideHoverTooltip();
    selectedSwapApplicantId = null;
    renderAll();
    openEditApplicantModal(applicant.id);
  });

  return chip;
}

function renderUnassignedPool() {
  const container = document.getElementById('unassigned-container');
  if (!container) return;
  container.innerHTML = '';

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  const unassignedList = sortApplicantsKSFirst(
    appState.applicants.filter(a => {
      const g = a[groupField] || '';
      return g === '' && matchesSearchAndCategory(a);
    })
  );

  setElText('unassigned-count', unassignedList.length);

  if (unassignedList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-hint';
    empty.textContent = 'จัดเข้ากลุ่มครบทุกคนแล้ว';
    container.appendChild(empty);
    return;
  }

  unassignedList.forEach(app => {
    container.appendChild(createApplicantChipElement(app));
  });
}

function renderGroupsGrid() {
  const grid = document.getElementById('groups-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const isStudentMode = appState.boardMode === 'student';
  const groupField = isStudentMode ? 'studentGroup' : 'parentGroup';
  let groups = isStudentMode ? appState.studentGroups : appState.parentGroups;

  if (appState.subGroupFilter !== 'ALL') {
    if (isStudentMode && appState.subGroupFilter.startsWith('ROOM_')) {
      const targetRoom = parseInt(appState.subGroupFilter.replace('ROOM_', ''), 10);
      groups = groups.filter(g => {
        const info = getEvalRoomInfo(g);
        return info && info.roomNumber === targetRoom;
      });
    } else if (!isStudentMode) {
      groups = groups.filter(g => g.toUpperCase().startsWith(appState.subGroupFilter));
    }
  }

  groups.forEach(groupName => {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.dataset.group = groupName;

    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('dragleave', handleDragLeave);
    card.addEventListener('drop', (e) => handleDrop(e, groupName));

    const allInGroup = appState.applicants.filter(a => a[groupField] === groupName);
    const members = sortApplicantsKSFirst(
      allInGroup.filter(a => matchesSearchAndCategory(a))
    );
    const totalMembersInGroup = allInGroup.length;

    const sibInGroup = allInGroup.filter(a => a.category === 'sibling').length;
    const cmuInGroup = allInGroup.filter(a => a.category === 'cmu').length;
    const twinInGroup = allInGroup.filter(a => a.category && a.category.startsWith('twin_')).length;

    let miniStatsHtml = '';
    if (twinInGroup > 0) miniStatsHtml += `<span class="mini-stat-pill mini-stat-twin" title="คู่แฝดในกลุ่มนี้">👯 ${twinInGroup}</span>`;
    if (sibInGroup > 0) miniStatsHtml += `<span class="mini-stat-pill mini-stat-sib" title="พี่น้อง ITPC ในกลุ่มนี้">🟢 ${sibInGroup}</span>`;
    if (cmuInGroup > 0) miniStatsHtml += `<span class="mini-stat-pill mini-stat-cmu" title="บุคลากร มช. ในกลุ่มนี้">🟣 ${cmuInGroup}</span>`;

    let roomTagHtml = '';
    if (isStudentMode) {
      const roomInfo = getEvalRoomInfo(groupName);
      if (roomInfo) {
        roomTagHtml = `<span class="room-sub-tag">${escapeHtml(roomInfo.label)}</span>`;
      }
    }

    const header = document.createElement('div');
    header.className = 'group-header' + (selectedSwapApplicantId ? ' swap-move-ready' : '');
    if (selectedSwapApplicantId) {
      header.title = `คลิกเพื่อย้ายรหัสที่เลือกเข้ามายังกลุ่ม ${groupName}`;
    }
    header.addEventListener('click', () => handleGroupHeaderClick(groupName));
    header.innerHTML = `
      <div class="group-title">
        <span>กลุ่ม ${escapeHtml(groupName)}</span>
        ${roomTagHtml}
      </div>
      <div class="group-header-right">
        ${miniStatsHtml}
        <span class="group-count">${totalMembersInGroup} คน</span>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'group-body';

    if (members.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'group-empty-hint';
      hint.textContent = 'คลิกเลือกรหัสแล้วคลิกหัวกลุ่มนี้ หรือลากมาวาง';
      body.appendChild(hint);
    } else {
      members.forEach(member => {
        body.appendChild(createApplicantChipElement(member));
      });
    }

    card.appendChild(header);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

// ==================== HOVER TOOLTIP ====================

function showHoverTooltip(event, applicant) {
  if (draggedApplicantId) return;
  const tooltip = document.getElementById('hover-tooltip');
  const meta = CATEGORY_META[applicant.category || 'general'] || CATEGORY_META.general;

  const fullName = [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') || '-';
  const nick = applicant.nickname ? ` (${applicant.nickname})` : '';
  const evalInfo = applicant.studentGroup ? getEvalRoomInfo(applicant.studentGroup) : null;
  const stuGroupDisplay = applicant.studentGroup
    ? `${applicant.studentGroup}${evalInfo ? ` • ${evalInfo.label}` : ''}`
    : 'ยังไม่จัด';
  const matchedInfo = (applicant.matchedSheets && applicant.matchedSheets.length > 0)
    ? `<div class="tooltip-row"><span class="tooltip-label">ชนชีต:</span> <span class="tooltip-val">${escapeHtml(applicant.matchedSheets.join(' + '))}</span></div>`
    : '';

  tooltip.innerHTML = `
    <div class="tooltip-header">
      <span class="tooltip-code">รหัส: ${escapeHtml(applicant.code)}</span>
      <span class="tooltip-cat-badge" style="background:${meta.badgeBg};color:${meta.badgeColor};">${escapeHtml(meta.label)}</span>
    </div>
    ${matchedInfo}
    <div class="tooltip-row">
      <span class="tooltip-label">นักเรียน:</span>
      <span class="tooltip-val">${escapeHtml(fullName)}${escapeHtml(nick)}</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">โรงเรียนเดิม:</span>
      <span class="tooltip-val">${escapeHtml(applicant.school || '-')}</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">ผู้ปกครอง:</span>
      <span class="tooltip-val">${escapeHtml(applicant.parentName || '-')}</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">อาชีพ/ที่ทำงาน:</span>
      <span class="tooltip-val">${escapeHtml(applicant.parentWork || '-')}</span>
    </div>
    ${applicant.note ? `<div class="tooltip-row"><span class="tooltip-label">หมายเหตุ:</span> <span class="tooltip-val">${escapeHtml(applicant.note)}</span></div>` : ''}
    <div class="tooltip-footer">
      <span>กลุ่มนักเรียน: <strong>${escapeHtml(stuGroupDisplay)}</strong></span>
      <span>กลุ่มผปค.: <strong>${escapeHtml(applicant.parentGroup || 'ยังไม่จัด')}</strong></span>
    </div>
  `;

  tooltip.classList.remove('hidden');
  moveHoverTooltip(event);
}

function moveHoverTooltip(event) {
  const tooltip = document.getElementById('hover-tooltip');
  if (tooltip.classList.contains('hidden')) return;

  const offset = 14;
  let left = event.clientX + offset;
  let top = event.clientY + offset;

  const rect = tooltip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 12) {
    left = event.clientX - rect.width - offset;
  }
  if (top + rect.height > window.innerHeight - 12) {
    top = event.clientY - rect.height - offset;
  }

  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function hideHoverTooltip() {
  const tooltip = document.getElementById('hover-tooltip');
  if (tooltip) tooltip.classList.add('hidden');
}

// ==================== DRAG & DROP HANDLERS ====================

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function handleDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

function handleDrop(event, targetGroupName) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');

  const applicantId = event.dataTransfer.getData('text/plain') || draggedApplicantId;
  if (!applicantId) return;

  const applicant = appState.applicants.find(a => a.id === applicantId);
  if (!applicant) return;

  if (appState.boardMode === 'student') {
    applicant.studentGroup = targetGroupName;
  } else {
    applicant.parentGroup = targetGroupName;
  }

  saveState();
  renderAll();
}

// ==================== MODE & FILTER CONTROLS ====================

function switchBoardMode(mode) {
  appState.boardMode = mode;
  appState.subGroupFilter = 'ALL';
  renderAll();
}

function setSubGroupFilter(filterVal) {
  appState.subGroupFilter = filterVal;
  renderAll();
}

function setCategoryFilter(filter) {
  if (appState.categoryFilter === filter && filter !== 'all') {
    appState.categoryFilter = 'all';
  } else {
    appState.categoryFilter = filter;
  }
  renderAll();
}

function handleSearchFilter() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('clear-search-btn');
  appState.searchQuery = input.value.trim();
  clearBtn.classList.toggle('hidden', appState.searchQuery === '');
  renderAll();
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  appState.searchQuery = '';
  document.getElementById('clear-search-btn').classList.add('hidden');
  renderAll();
}

// ==================== APPLICANT MODAL ====================

function populateGroupDropdownsInModal() {
  const stuSelect = document.getElementById('edit-student-group');
  const parSelect = document.getElementById('edit-parent-group');

  stuSelect.innerHTML = `<option value="">-- ยังไม่จัดกลุ่มนักเรียน --</option>` +
    appState.studentGroups.map(g => {
      const info = getEvalRoomInfo(g);
      const extra = info ? ` (${info.label})` : '';
      return `<option value="${escapeHtml(g)}">กลุ่ม ${escapeHtml(g)}${escapeHtml(extra)}</option>`;
    }).join('');

  parSelect.innerHTML = `<option value="">-- ยังไม่จัดกลุ่มผู้ปกครอง --</option>` +
    appState.parentGroups.map(g => `<option value="${escapeHtml(g)}">กลุ่ม ${escapeHtml(g)}</option>`).join('');
}

function openAddApplicantModal() {
  editingApplicantId = null;
  populateGroupDropdownsInModal();

  document.getElementById('modal-applicant-code').textContent = '➕ เพิ่มรหัสผู้สมัครใหม่';
  document.getElementById('edit-code').value = '';
  document.getElementById('edit-firstname').value = '';
  document.getElementById('edit-lastname').value = '';
  document.getElementById('edit-nickname').value = '';
  document.getElementById('edit-school').value = '';
  document.getElementById('edit-parent-name').value = '';
  document.getElementById('edit-parent-work').value = '';
  document.getElementById('edit-student-group').value = '';
  document.getElementById('edit-parent-group').value = '';
  document.getElementById('edit-note').value = '';

  document.getElementById('btn-delete-applicant').classList.add('hidden');
  document.getElementById('same-lastname-alert').classList.add('hidden');

  selectModalCategory('general');
  document.getElementById('applicant-modal').classList.remove('hidden');
}

function openEditApplicantModal(applicantId) {
  const applicant = appState.applicants.find(a => a.id === applicantId);
  if (!applicant) return;

  editingApplicantId = applicant.id;
  populateGroupDropdownsInModal();

  document.getElementById('modal-applicant-code').textContent = `รหัสผู้สมัคร: ${applicant.code}`;
  document.getElementById('edit-code').value = applicant.code || '';
  document.getElementById('edit-firstname').value = applicant.firstName || '';
  document.getElementById('edit-lastname').value = applicant.lastName || '';
  document.getElementById('edit-nickname').value = applicant.nickname || '';
  document.getElementById('edit-school').value = applicant.school || '';
  document.getElementById('edit-parent-name').value = applicant.parentName || '';
  document.getElementById('edit-parent-work').value = applicant.parentWork || '';
  document.getElementById('edit-student-group').value = applicant.studentGroup || '';
  document.getElementById('edit-parent-group').value = applicant.parentGroup || '';
  document.getElementById('edit-note').value = applicant.note || '';

  document.getElementById('btn-delete-applicant').classList.remove('hidden');

  selectModalCategory(applicant.category || 'general');

  const pKey = normalizeParentNameKey(applicant.parentName);
  const alertBox = document.getElementById('same-lastname-alert');
  if (pKey) {
    const matches = appState.applicants.filter(a => a.id !== applicant.id && normalizeParentNameKey(a.parentName) === pKey);
    if (matches.length > 0) {
      const matchDesc = matches.map(m => `รหัส ${m.code} (${m.firstName} ${m.lastName})`).join(', ');
      alertBox.innerHTML = `👯 <strong>พบผู้ปกครองชื่อ "${escapeHtml(pKey)}" เดียวกับคู่แฝด:</strong> ${escapeHtml(matchDesc)}`;
      alertBox.classList.remove('hidden');
    } else {
      alertBox.classList.add('hidden');
    }
  } else {
    alertBox.classList.add('hidden');
  }

  document.getElementById('applicant-modal').classList.remove('hidden');
}

function selectModalCategory(cat) {
  selectedModalCategory = cat;
  document.querySelectorAll('#modal-color-selector .color-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.cat === cat);
  });
}

function saveApplicantModal() {
  const code = document.getElementById('edit-code').value.trim();
  const firstName = document.getElementById('edit-firstname').value.trim();
  const lastName = document.getElementById('edit-lastname').value.trim();
  const nickname = document.getElementById('edit-nickname').value.trim();
  const school = document.getElementById('edit-school').value.trim();
  const parentName = document.getElementById('edit-parent-name').value.trim();
  const parentWork = document.getElementById('edit-parent-work').value.trim();
  const studentGroup = document.getElementById('edit-student-group').value;
  const parentGroup = document.getElementById('edit-parent-group').value;
  const note = document.getElementById('edit-note').value.trim();

  if (!code) {
    alert('กรุณาระบุรหัสผู้สมัคร');
    return;
  }

  let finalCategory = selectedModalCategory;
  if (finalCategory === 'general' && isCmuStaffWorkplace(parentWork) && !editingApplicantId) {
    finalCategory = 'cmu';
  }

  if (editingApplicantId) {
    const app = appState.applicants.find(a => a.id === editingApplicantId);
    if (app) {
      app.code = code;
      app.firstName = firstName;
      app.lastName = lastName;
      app.nickname = nickname;
      app.school = school;
      app.parentName = parentName;
      app.parentWork = parentWork;
      app.category = finalCategory;
      app.manualCategory = true;
      app.studentGroup = studentGroup;
      app.parentGroup = parentGroup;
      app.note = note;
    }
  } else {
    appState.applicants.push({
      id: 'app_' + Date.now(),
      code,
      firstName,
      lastName,
      nickname,
      school,
      parentName,
      parentWork,
      category: finalCategory,
      manualCategory: true,
      studentGroup,
      parentGroup,
      note
    });
  }

  saveState();
  renderAll();
  closeModal('applicant-modal');
  showToast(`💾 บันทึกข้อมูลรหัส ${code} เรียบร้อยแล้ว`);
}

function deleteCurrentApplicant() {
  if (!editingApplicantId) return;
  const app = appState.applicants.find(a => a.id === editingApplicantId);
  if (!app) return;
  if (!confirm(`ต้องการลบรหัสผู้สมัคร ${app.code} ใช่หรือไม่?`)) return;

  appState.applicants = appState.applicants.filter(a => a.id !== editingApplicantId);
  saveState();
  renderAll();
  closeModal('applicant-modal');
  showToast(`🗑️ ลบรหัส ${app.code} แล้ว`);
}

// ==================== GROUP MANAGEMENT ====================

function quickAddGroup() {
  const input = document.getElementById('quick-group-input');
  const raw = input.value.trim();
  const targetList = appState.boardMode === 'student' ? appState.studentGroups : appState.parentGroups;

  if (!raw) {
    if (appState.boardMode === 'student') {
      let nextIdx = targetList.length;
      while (targetList.includes(indexToAlphaGroup(nextIdx))) {
        nextIdx++;
      }
      const nextName = indexToAlphaGroup(nextIdx);
      targetList.push(nextName);
      saveState();
      renderAll();
      showToast(`➕ เพิ่มกลุ่ม ${nextName} เรียบร้อยแล้ว`);
      return;
    } else {
      addParentSubgroupSeries();
      return;
    }
  }

  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  let added = 0;
  names.forEach(name => {
    if (!targetList.includes(name)) {
      targetList.push(name);
      added++;
    }
  });

  input.value = '';
  if (added > 0) {
    saveState();
    renderAll();
    showToast(`➕ เพิ่มกลุ่มใหม่จำนวน ${added} กลุ่มเรียบร้อยแล้ว`);
  } else {
    showToast('⚠️ ชื่อกลุ่มนี้มีอยู่แล้ว');
  }
}

function openManageGroupsModal() {
  const title = document.getElementById('manage-groups-title');
  title.textContent = appState.boardMode === 'student'
    ? '⚙️ จัดการกลุ่มสอบนักเรียน (A - AD และกลุ่มเพิ่มเติม)'
    : '⚙️ จัดการกลุ่มผู้ปกครอง (A1 - O3 และกลุ่มเพิ่มเติม)';
  renderManageGroupsChips();
  document.getElementById('manage-groups-modal').classList.remove('hidden');
}

function renderManageGroupsChips() {
  const container = document.getElementById('manage-groups-list');
  const targetList = appState.boardMode === 'student' ? appState.studentGroups : appState.parentGroups;

  container.innerHTML = targetList.map(g => `
    <span class="group-manage-chip">
      <span>กลุ่ม ${escapeHtml(g)}</span>
      <button type="button" onclick="removeGroup('${escapeHtml(g)}')" title="ลบกลุ่มนี้">✕</button>
    </span>
  `).join('');
}

function addCustomGroupsFromModal() {
  const input = document.getElementById('new-group-name-input');
  const raw = input.value.trim();
  if (!raw) return;

  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  const targetList = appState.boardMode === 'student' ? appState.studentGroups : appState.parentGroups;

  names.forEach(name => {
    if (!targetList.includes(name)) targetList.push(name);
  });

  input.value = '';
  saveState();
  renderManageGroupsChips();
  renderAll();
}

function removeGroup(groupName) {
  const isStu = appState.boardMode === 'student';
  const groupField = isStu ? 'studentGroup' : 'parentGroup';

  appState.applicants.forEach(a => {
    if (a[groupField] === groupName) a[groupField] = '';
  });

  if (isStu) {
    appState.studentGroups = appState.studentGroups.filter(g => g !== groupName);
  } else {
    appState.parentGroups = appState.parentGroups.filter(g => g !== groupName);
  }

  saveState();
  renderManageGroupsChips();
  renderAll();
}

function resetStudentGroups1To30() {
  appState.studentGroups = getDefaultStudentGroups1To30();
  appState.subGroupFilter = 'ALL';
  saveState();
  renderManageGroupsChips();
  renderAll();
  showToast('ตั้งกลุ่มนักเรียนเป็น 30 กลุ่ม (A - AD • 6 ห้องประเมิน) เรียบร้อยแล้ว');
}

function resetStudentGroupsAZ() {
  appState.studentGroups = getStudentGroupsAZ();
  appState.subGroupFilter = 'ALL';
  saveState();
  renderManageGroupsChips();
  renderAll();
  showToast('ตั้งกลุ่มนักเรียนเป็น A - Z (26 กลุ่ม) เรียบร้อยแล้ว');
}

function resetParentGroupsDefault() {
  appState.parentGroups = getDefaultParentGroups();
  appState.subGroupFilter = 'ALL';
  saveState();
  renderManageGroupsChips();
  renderAll();
  showToast('รีเซ็ตกลุ่มผู้ปกครองเป็น A1-A3 ถึง O1-O3 เรียบร้อย');
}

function addParentSubgroupSeries() {
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    if (!appState.parentGroups.includes(`${letter}1`)) {
      appState.parentGroups.push(`${letter}1`, `${letter}2`, `${letter}3`);
      saveState();
      renderManageGroupsChips();
      renderAll();
      showToast(`➕ เพิ่มกลุ่ม ${letter}1, ${letter}2, ${letter}3 เรียบร้อยแล้ว`);
      return;
    }
  }
}

// ==================== AUTO-ASSIGN & CLEAR BOARD ====================

function openAutoAssignModal() {
  document.getElementById('auto-assign-title').textContent =
    appState.boardMode === 'student'
      ? '🎲 จัดแบ่งกลุ่มนักเรียนอัตโนมัติ (A - AD)'
      : '🎲 จัดแบ่งกลุ่มผู้ปกครองอัตโนมัติ (A1 - O3)';
  document.getElementById('auto-assign-modal').classList.remove('hidden');
}

function runAutoAssign() {
  const isStu = appState.boardMode === 'student';
  const groupField = isStu ? 'studentGroup' : 'parentGroup';
  const groups = isStu ? [...appState.studentGroups] : [...appState.parentGroups];

  if (groups.length === 0) return;

  const mode = document.getElementById('auto-assign-mode').value;
  const twinRule = document.getElementById('auto-twin-rule').value;
  const maxPerGroupVal = parseInt(document.getElementById('auto-max-per-group').value, 10);
  const maxPerGroup = (!isNaN(maxPerGroupVal) && maxPerGroupVal > 0) ? maxPerGroupVal : Infinity;

  if (mode === 'sequential_1_30') {
    assignSequentialRooms1To30();
    closeModal('auto-assign-modal');
    return;
  }

  const unassigned = appState.applicants.filter(a => !a[groupField]);
  const targetPool = unassigned.length > 0 ? unassigned : [...appState.applicants];

  if (mode === 'fill_room_by_room') {
    const sorted = [...targetPool].sort((a, b) =>
      String(a.code).localeCompare(String(b.code), 'th', { numeric: true })
    );
    const cap = maxPerGroup !== Infinity ? maxPerGroup : Math.ceil(sorted.length / groups.length);
    sorted.forEach((app, idx) => {
      const gIdx = Math.min(Math.floor(idx / cap), groups.length - 1);
      app[groupField] = groups[gIdx];
    });
    saveState();
    renderAll();
    closeModal('auto-assign-modal');
    showToast('⚡ จัดแบ่งห้องแบบเติมเต็มทีละกลุ่มเรียบร้อยแล้ว');
    return;
  }

  const getNextAvailableGroup = (excludeGroup = null) => {
    const counts = {};
    groups.forEach(g => { counts[g] = 0; });
    appState.applicants.forEach(a => {
      if (a[groupField] && counts[a[groupField]] !== undefined) {
        counts[a[groupField]]++;
      }
    });

    const candidates = groups
      .filter(g => g !== excludeGroup && counts[g] < maxPerGroup)
      .sort((a, b) => counts[a] - counts[b]);

    return candidates.length > 0 ? candidates[0] : null;
  };

  const processedIds = new Set();
  if (twinRule === 'same' || twinRule === 'separate') {
    for (let i = 1; i <= 7; i++) {
      const twinCat = `twin_${i}`;
      const pair = targetPool.filter(a => a.category === twinCat);
      if (pair.length >= 2) {
        const firstGroup = getNextAvailableGroup();
        if (firstGroup) {
          pair[0][groupField] = firstGroup;
          processedIds.add(pair[0].id);
          for (let k = 1; k < pair.length; k++) {
            const targetG = twinRule === 'same' ? firstGroup : (getNextAvailableGroup(firstGroup) || firstGroup);
            pair[k][groupField] = targetG;
            processedIds.add(pair[k].id);
          }
        }
      }
    }
  }

  const remaining = targetPool.filter(a => !processedIds.has(a.id));
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
  }

  remaining.forEach(app => {
    const g = getNextAvailableGroup();
    if (g) app[groupField] = g;
  });

  saveState();
  renderAll();
  closeModal('auto-assign-modal');
  showToast('⚡ จัดแบ่งกลุ่มอัตโนมัติเรียบร้อยแล้ว');
}

function clearCurrentBoardAssignments() {
  const label = appState.boardMode === 'student' ? 'กลุ่มนักเรียน (A-AD)' : 'กลุ่มผู้ปกครอง (A1-O3)';
  if (!confirm(`ต้องการล้างการจัดกลุ่มทั้งหมดในกระดาน "${label}" เพื่อให้กลับไปเริ่มจัดใหม่ใช่หรือไม่?`)) {
    return;
  }

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  appState.applicants.forEach(a => {
    a[groupField] = '';
  });

  saveState();
  renderAll();
  showToast(`🔄 ล้างการจัดกลุ่มในกระดาน ${label} เรียบร้อยแล้ว`);
}

// ==================== ONLINE CLOUD SYNC (GOOGLE APPS SCRIPT) ====================

function openGoogleSheetModal() {
  document.getElementById('gsheet-url-input').value = appState.gsheetUrl || DEFAULT_GSHEET_URL;
  document.getElementById('apps-script-url-input').value = appState.appsScriptUrl || '';
  document.getElementById('gsheet-modal').classList.remove('hidden');
}

function toggleAppsScriptGuide() {
  const guide = document.getElementById('apps-script-guide');
  guide.classList.toggle('hidden');
}

function copyGasSnippet() {
  const code = document.getElementById('gas-code-snippet').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showToast('📋 คัดลอกโค้ด Google Apps Script เรียบร้อยแล้ว');
  });
}

function saveAppsScriptUrl() {
  const val = document.getElementById('apps-script-url-input').value.trim();
  appState.appsScriptUrl = val;
  saveState(false);
  showToast('💾 บันทึก Web App URL สำหรับซิงค์ออนไลน์เรียบร้อยแล้ว');
}

let lastAppliedCloudTimestamp = '';

function buildCompactCloudPayload() {
  const map = {};
  appState.applicants.forEach(a => {
    map[a.code] = [
      a.studentGroup || '',
      a.parentGroup || '',
      a.manualCategory ? (a.category || '') : '',
      a.note || ''
    ];
  });
  return {
    v: 2,
    updatedAt: new Date().toISOString(),
    appsScriptUrl: appState.appsScriptUrl || '',
    studentGroups: appState.studentGroups,
    parentGroups: appState.parentGroups,
    map
  };
}

function applyCloudStateObject(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.updatedAt && data.updatedAt === lastAppliedCloudTimestamp) {
    return false;
  }

  let changed = false;

  if (data.appsScriptUrl && !appState.appsScriptUrl) {
    appState.appsScriptUrl = String(data.appsScriptUrl).trim();
    const gasInput = document.getElementById('apps-script-url-input');
    if (gasInput) gasInput.value = appState.appsScriptUrl;
  }

  if (Array.isArray(data.studentGroups) && data.studentGroups.length > 0) {
    appState.studentGroups = data.studentGroups;
    changed = true;
  }
  if (Array.isArray(data.parentGroups) && data.parentGroups.length > 0) {
    appState.parentGroups = data.parentGroups;
    changed = true;
  }

  if (data.map && typeof data.map === 'object') {
    appState.applicants.forEach(a => {
      const entry = data.map[a.code];
      if (Array.isArray(entry)) {
        a.studentGroup = entry[0] || '';
        a.parentGroup = entry[1] || '';
        if (entry[2]) {
          a.category = entry[2];
          a.manualCategory = true;
        }
        if (entry[3] !== undefined) {
          a.note = entry[3];
        }
        changed = true;
      }
    });
  } else if (Array.isArray(data.applicants) && data.applicants.length > 0) {
    const byCode = {};
    data.applicants.forEach(ca => {
      if (ca && ca.code) byCode[String(ca.code).trim()] = ca;
    });
    appState.applicants.forEach(a => {
      const ca = byCode[String(a.code).trim()];
      if (ca) {
        a.studentGroup = ca.studentGroup || '';
        a.parentGroup = ca.parentGroup || '';
        if (ca.manualCategory && ca.category) {
          a.category = ca.category;
          a.manualCategory = true;
        }
        if (ca.note !== undefined) a.note = ca.note;
        changed = true;
      }
    });
  }

  if (changed) {
    if (data.updatedAt) lastAppliedCloudTimestamp = data.updatedAt;
    saveState(false);
    renderAll();
  }
  return changed;
}

function applyAppStateSheetRows(appStateRows) {
  if (!Array.isArray(appStateRows) || appStateRows.length === 0) return false;
  for (let r = 0; r < Math.min(3, appStateRows.length); r++) {
    const row = appStateRows[r] || [];
    for (let c = 0; c < Math.min(3, row.length); c++) {
      const cellStr = String(row[c] || '').trim();
      if (cellStr.startsWith('{') && cellStr.endsWith('}')) {
        try {
          const parsed = JSON.parse(cellStr);
          if (applyCloudStateObject(parsed)) {
            return true;
          }
        } catch (_) {}
      }
    }
  }
  return false;
}

function copyStateToPasteInSheet() {
  const payloadStr = JSON.stringify(buildCompactCloudPayload());
  navigator.clipboard.writeText(payloadStr).then(() => {
    showToast('📋 คัดลอกข้อมูลจัดกลุ่มแล้ว! นำไปวาง (Ctrl+V / Cmd+V) ในช่อง A1 ของชีตชื่อ AppState บน Google Sheet ได้เลยครับ');
    showSheetStatus(
      '✅ คัดลอกแล้ว! ไปที่ Google Sheet ของคุณ > สร้างชีตชื่อ AppState > คลิกช่อง A1 แล้วกดวาง (Ctrl+V / Cmd+V) เครื่องอื่นๆ ที่เปิดเว็บจะอัปเดตตามทันทีครับ',
      'success'
    );
  }).catch(() => {
    prompt('คัดลอกข้อความด้านล่างไปวางในช่อง A1 ของชีต AppState บน Google Sheet:', payloadStr);
  });
}

let lastLocalSaveTime = 0;

function scheduleCloudSave() {
  const url = appState.appsScriptUrl || DEFAULT_APPS_SCRIPT_URL;
  if (!url) return;
  lastLocalSaveTime = Date.now();
  if (cloudSaveTimeout) clearTimeout(cloudSaveTimeout);
  cloudSaveTimeout = setTimeout(() => {
    pushStateToCloudNow(true);
  }, 400);
}

async function pushStateToCloudNow(silent = false) {
  const url = document.getElementById('apps-script-url-input')?.value.trim() || appState.appsScriptUrl || DEFAULT_APPS_SCRIPT_URL;
  if (!url) {
    if (!silent) {
      copyStateToPasteInSheet();
    }
    return;
  }
  appState.appsScriptUrl = url;
  lastLocalSaveTime = Date.now();
  setSyncBadge('saving', '☁️ กำลังบันทึกเรียลไทม์...');

  try {
    const payloadObj = buildCompactCloudPayload();
    lastAppliedCloudTimestamp = payloadObj.updatedAt;
    const payload = JSON.stringify(payloadObj);

    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload
    });

    lastLocalSaveTime = Date.now();
    setSyncBadge('ok', '☁️ บันทึกเรียลไทม์แล้ว');
    if (!silent) showToast('☁️ บันทึกสถานะการจัดกลุ่มขึ้นชีต AppState ออนไลน์เรียบร้อยแล้ว');
  } catch (err) {
    console.warn('Cloud push error:', err);
    setSyncBadge('ready', '☁️ เชื่อมต่อ Google Sheet');
    if (!silent) showToast('⚠️ ไม่สามารถบันทึกออนไลน์ได้ กรุณาตรวจสอบ Web App URL');
  }
}

async function pullStateFromCloudNow(silent = false) {
  const sheetId = extractSpreadsheetId(appState.gsheetUrl || DEFAULT_GSHEET_URL);
  const url = document.getElementById('apps-script-url-input')?.value.trim() || appState.appsScriptUrl || DEFAULT_APPS_SCRIPT_URL;
  if (!silent) setSyncBadge('saving', '⏳ กำลังโหลดจาก Cloud...');

  // 1. ดึงจาก Web App URL โดยตรง (ไม่ติด Cache อัปเดตไวที่สุด)
  if (url) {
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}action=loadState&_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (applyCloudStateObject(data)) {
          setSyncBadge('ok', '☁️ ซิงค์เรียลไทม์ล่าสุด');
          if (!silent) showToast('📥 โหลดสถานะการจัดกลุ่มล่าสุดจาก Cloud เรียบร้อยแล้ว');
          return;
        }
      }
    } catch (_) {}
  }

  // 2. หรือดึงจากชีต AppState บน Google Sheet โดยตรงผ่าน JSONP
  try {
    const appStateRows = await fetchSingleSheetRows(sheetId, 'AppState', null);
    if (appStateRows && applyAppStateSheetRows(appStateRows)) {
      setSyncBadge('ok', '☁️ ซิงค์เรียลไทม์ล่าสุด');
      if (!silent) showToast('📥 โหลดสถานะการจัดกลุ่มล่าสุดจากชีต AppState เรียบร้อยแล้ว');
      return;
    }
  } catch (_) {}

  setSyncBadge('ok', '☁️ ซิงค์เรียลไทม์แล้ว');
}

// ซิงค์สถานะจากชีต AppState อัตโนมัติทุกๆ 8 วินาที เพื่อให้เครื่องอื่นเห็นการเปลี่ยนแปลงตามกันแบบเรียลไทม์
setInterval(async () => {
  if (draggedApplicantId || selectedSwapApplicantId || editingApplicantId) return;
  if (Date.now() - lastLocalSaveTime < 4500) return;
  await pullStateFromCloudNow(true);
}, 8000);

// ==================== EXCEL (.XLSX) IMPORT & EXPORT ====================

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const mergeCheckbox = document.getElementById('merge-mode-checkbox');
  const mergeExisting = mergeCheckbox ? mergeCheckbox.checked : true;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const findSheetCI = (targetName) => {
        const found = workbook.SheetNames.find(n => n.trim().toLowerCase() === targetName.toLowerCase());
        return found ? workbook.Sheets[found] : null;
      };
      const dataSheet = findSheetCI('data') || workbook.Sheets[workbook.SheetNames[0]];
      const cmuSheet = findSheetCI('CMU');
      const itpcSheet = findSheetCI('ITPC');

      const rows = XLSX.utils.sheet_to_json(dataSheet, { header: 1, defval: '' });
      const cmuRows = cmuSheet ? XLSX.utils.sheet_to_json(cmuSheet, { header: 1, defval: '' }) : null;
      const itpcRows = itpcSheet ? XLSX.utils.sheet_to_json(itpcSheet, { header: 1, defval: '' }) : null;

      const count = processSheetRows(rows, mergeExisting, cmuRows, itpcRows);
      closeModal('gsheet-modal');
      showToast(`📥 นำเข้าข้อมูลจากไฟล์สำเร็จ (${count} รหัสผู้สมัคร)`);
    } catch (err) {
      alert('ไม่สามารถอ่านไฟล์ Excel/CSV นี้ได้: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

function exportToExcel() {
  if (appState.applicants.length === 0) {
    alert('ยังไม่มีข้อมูลผู้สมัครสำหรับส่งออกเป็นไฟล์ Excel');
    return;
  }

  const wb = XLSX.utils.book_new();

  const masterRows = appState.applicants.map(a => {
    const meta = CATEGORY_META[a.category || 'general'] || CATEGORY_META.general;
    const roomInfo = a.studentGroup ? getEvalRoomInfo(a.studentGroup) : null;
    return {
      'รหัสผู้สมัคร': a.code,
      'ชื่อนักเรียน': a.firstName,
      'นามสกุลนักเรียน': a.lastName,
      'ชื่อเล่น': a.nickname,
      'โรงเรียนเดิม': a.school,
      'ชื่อผู้ปกครอง': a.parentName,
      'อาชีพ/สถานที่ทำงานผู้ปกครอง': a.parentWork,
      'สถานะสี': meta.label,
      'กลุ่มนักเรียน (A-AD)': a.studentGroup || 'ยังไม่จัดกลุ่ม',
      'ห้องประเมิน (1-6)': roomInfo ? roomInfo.label : '-',
      'กลุ่มผู้ปกครอง (A1-O3)': a.parentGroup || 'ยังไม่จัดกลุ่ม',
      'หมายเหตุ': a.note || ''
    };
  });
  const wsMaster = XLSX.utils.json_to_sheet(masterRows);
  XLSX.utils.book_append_sheet(wb, wsMaster, 'รวมทั้งหมด');

  const studentSorted = [...appState.applicants].sort((a, b) => {
    const orderA = groupNameToOrderNumber(a.studentGroup) || 9999;
    const orderB = groupNameToOrderNumber(b.studentGroup) || 9999;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.code).localeCompare(String(b.code), 'en', { numeric: true });
  });
  const studentRows = studentSorted.map(a => {
    const meta = CATEGORY_META[a.category || 'general'] || CATEGORY_META.general;
    const roomInfo = a.studentGroup ? getEvalRoomInfo(a.studentGroup) : null;
    return {
      'กลุ่มนักเรียน': a.studentGroup || 'ยังไม่จัดกลุ่ม',
      'ห้องประเมิน': roomInfo ? roomInfo.label : '-',
      'รหัสผู้สมัคร': a.code,
      'ชื่อ-นามสกุลนักเรียน': [a.firstName, a.lastName].filter(Boolean).join(' '),
      'ชื่อเล่น': a.nickname,
      'โรงเรียนเดิม': a.school,
      'สถานะสี': meta.label,
      'หมายเหตุ': a.note || ''
    };
  });
  const wsStudent = XLSX.utils.json_to_sheet(studentRows);
  XLSX.utils.book_append_sheet(wb, wsStudent, 'กลุ่มนักเรียน (A-AD)');

  const parentSorted = [...appState.applicants].sort((a, b) => {
    if (!a.parentGroup && b.parentGroup) return 1;
    if (a.parentGroup && !b.parentGroup) return -1;
    return String(a.parentGroup).localeCompare(String(b.parentGroup), 'en', { numeric: true }) ||
           String(a.code).localeCompare(String(b.code), 'en', { numeric: true });
  });
  const parentRows = parentSorted.map(a => {
    const meta = CATEGORY_META[a.category || 'general'] || CATEGORY_META.general;
    return {
      'กลุ่มผู้ปกครอง': a.parentGroup || 'ยังไม่จัดกลุ่ม',
      'รหัสผู้สมัคร': a.code,
      'ชื่อผู้ปกครอง': a.parentName,
      'อาชีพ/สถานที่ทำงานผู้ปกครอง': a.parentWork,
      'ชื่อ-นามสกุลนักเรียน': [a.firstName, a.lastName].filter(Boolean).join(' '),
      'สถานะสี': meta.label,
      'หมายเหตุ': a.note || ''
    };
  });
  const wsParent = XLSX.utils.json_to_sheet(parentRows);
  XLSX.utils.book_append_sheet(wb, wsParent, 'กลุ่มผู้ปกครอง (A1-O3)');

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `ผลการจัดกลุ่มสอบเข้า_${dateStr}.xlsx`);
  showToast('📥 ดาวน์โหลดไฟล์ Excel (.xlsx) เรียบร้อยแล้ว');
}

// ==================== UI HELPERS ====================

function setSyncBadge(state, text) {
  const badge = document.getElementById('cloud-sync-badge');
  if (!badge) return;
  badge.className = 'sync-badge ' + (state === 'ok' ? 'sync-ok' : state === 'saving' ? 'sync-saving' : 'sync-ready');
  badge.textContent = text;
}

function showSheetStatus(message, type) {
  const box = document.getElementById('gsheet-status');
  if (!box) return;
  box.textContent = message;
  box.className = `status-msg ${type === 'error' ? 'error' : 'success'}`;
  box.classList.remove('hidden');
}

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.add('hidden');
}

function closeModalOnBackdrop(event, modalId) {
  if (event.target.id === modalId) {
    closeModal(modalId);
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3600);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}