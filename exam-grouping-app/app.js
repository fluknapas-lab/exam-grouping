/**
 * ระบบจัดแบ่งกลุ่มสอบเข้า (นักเรียน 1-30 / A-Z & ผู้ปกครอง A1-O3)
 * เชื่อมต่อ Google Sheet อัตโนมัติ + รองรับการบันทึกออนไลน์และส่งออก Excel (.xlsx)
 *
 * คอลัมน์ใน Google Sheet ที่อ่านตามกำหนด:
 * - คอลัมน์ A (index 0): รหัสผู้สมัคร
 * - คอลัมน์ D (index 3): ชื่อนักเรียน
 * - คอลัมน์ E (index 4): นามสกุลนักเรียน (ใช้เช็คคู่แฝด 7 คู่)
 * - คอลัมน์ F (index 5): ชื่อเล่นนักเรียน
 * - คอลัมน์ L (index 11): โรงเรียนเดิม
 * - คอลัมน์ S (index 18): ชื่อผู้ปกครอง
 * - คอลัมน์ Y (index 24): อาชีพ / สถานที่ทำงานผู้ปกครอง (เช็คคำว่า มหาวิทยาลัยเชียงใหม่ / มช. / มช / ศรีพัฒน์ -> สีม่วง)
 */

const DEFAULT_GSHEET_ID = '1Canvfb_qiRbGdRUuhgXgJsy5q1FwqYmfLdXMqMXXHHM';
const DEFAULT_GSHEET_URL = `https://docs.google.com/spreadsheets/d/${DEFAULT_GSHEET_ID}/edit?usp=sharing`;
const STORAGE_KEY = 'exam_grouping_app_state_v2';

// Category Metadata
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
 * แปลงลำดับ (0, 1, 2 ...) เป็นชื่อกลุ่มตัวอักษร A..Z, AA, AB, AC, AD ...
 * เช่น 0 -> A, 25 -> Z, 26 -> AA, 27 -> AB, 28 -> AC, 29 -> AD
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

/**
 * แปลงชื่อกลุ่มตัวอักษร (A..Z, AA..AZ) หรือตัวเลข ('1'..'30') กลับเป็นลำดับที่ 1..30 (1-based)
 */
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
    return val; // A=1, Z=26, AA=27, AB=28, AC=29, AD=30
  }
  return null;
}

// Generate default Student Groups: 30 groups (A to Z, then AA, AB, AC, AD)
function getDefaultStudentGroups1To30() {
  return Array.from({ length: 30 }, (_, i) => indexToAlphaGroup(i));
}

function getStudentGroupsAZ() {
  return Array.from({ length: 26 }, (_, i) => indexToAlphaGroup(i));
}

function getDefaultParentGroups() {
  // A1, A2, A3 ... to O1, O2, O3 (15 letters * 3 = 45 groups)
  const groups = [];
  for (let i = 0; i < 15; i++) {
    const letter = String.fromCharCode(65 + i); // A..O
    groups.push(`${letter}1`, `${letter}2`, `${letter}3`);
  }
  return groups;
}

/**
 * คำนวณว่ากลุ่มที่ A..AD (1..30) อยู่ห้องประเมินไหน (ห้องประเมิน 1 - 6) และรอบที่เท่าไหร่
 * - กลุ่ม A-F (1-6) = รอบที่ 1 (ห้องประเมิน 1-6)
 * - กลุ่ม G-L (7-12) = รอบที่ 2 (ห้องประเมิน 1-6) ... ไปจนถึง กลุ่ม Y-AD (25-30) = รอบที่ 5
 */
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

// Application State
let appState = {
  boardMode: 'student', // 'student' | 'parent'
  subGroupFilter: 'ALL', // 'ALL', 'ROOM_1'..'ROOM_6' for student mode, or 'A'..'O' for parent mode
  categoryFilter: 'all',
  searchQuery: '',
  gsheetUrl: DEFAULT_GSHEET_URL,
  appsScriptUrl: '',
  studentGroups: getDefaultStudentGroups1To30(),
  parentGroups: getDefaultParentGroups(),
  applicants: [] // { id, code, firstName, lastName, nickname, school, parentName, parentWork, category, manualCategory, studentGroup, parentGroup, note }
};

let editingApplicantId = null;
let selectedModalCategory = 'general';
let draggedApplicantId = null;
let cloudSaveTimeout = null;

// ==================== INITIALIZATION ====================

window.addEventListener('DOMContentLoaded', async () => {
  loadStateFromLocal();
  renderAll();

  if (appState.appsScriptUrl) {
    await pullStateFromCloudNow(true);
  }

  await syncFromDefaultGoogleSheet(true);
});

function loadStateFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('exam_grouping_app_state_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.applicants)) {
        appState.applicants = parsed.applicants.map(a => {
          // Convert any numeric studentGroup ('1'..'30') to 'A'..'AD'
          if (a.studentGroup && /^\d+$/.test(String(a.studentGroup).trim())) {
            const n = parseInt(a.studentGroup, 10);
            if (n >= 1) a.studentGroup = indexToAlphaGroup(n - 1);
          }
          return a;
        });
      }
      if (parsed && Array.isArray(parsed.studentGroups) && parsed.studentGroups.length > 0) {
        // Upgrade numeric 1..30 or 26-group A..Z to 30 groups A..AD
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

  const gsheetInput = document.getElementById('gsheet-url-input');
  if (gsheetInput) gsheetInput.value = appState.gsheetUrl || DEFAULT_GSHEET_URL;

  const gasInput = document.getElementById('apps-script-url-input');
  if (gasInput) gasInput.value = appState.appsScriptUrl || '';
}

function saveState(triggerCloud = true) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      gsheetUrl: appState.gsheetUrl,
      appsScriptUrl: appState.appsScriptUrl,
      studentGroups: appState.studentGroups,
      parentGroups: appState.parentGroups,
      applicants: appState.applicants
    }));
  } catch (err) {
    console.warn('Local storage quota or save issue:', err);
  }

  if (triggerCloud && appState.appsScriptUrl) {
    scheduleCloudSave();
  }
}

// ==================== AUTO-DETECTION: CMU STAFF & 7 TWIN PAIRS ====================

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

function runAutoClassification(forceRecalculate = false) {
  const lastNameGroups = {};
  appState.applicants.forEach(app => {
    const ln = normalizeLastName(app.lastName, app.firstName);
    if (ln) {
      if (!lastNameGroups[ln]) lastNameGroups[ln] = [];
      lastNameGroups[ln].push(app);
    }
  });

  const duplicateLastNames = Object.keys(lastNameGroups).filter(ln => lastNameGroups[ln].length >= 2);
  const twinColorMap = {};
  duplicateLastNames.slice(0, 7).forEach((ln, idx) => {
    twinColorMap[ln] = `twin_${idx + 1}`;
  });

  appState.applicants.forEach(app => {
    if (app.manualCategory && !forceRecalculate) {
      return;
    }

    const ln = normalizeLastName(app.lastName, app.firstName);
    if (ln && twinColorMap[ln]) {
      app.category = twinColorMap[ln];
    } else if (isCmuStaffWorkplace(app.parentWork)) {
      app.category = 'cmu';
    } else {
      if (!app.category || forceRecalculate) {
        app.category = 'general';
      }
    }
  });
}

function normalizeLastName(lastName, firstName) {
  // Combine D and E to handle all cases:
  // Case 1: D = ชื่อ, E = นามสกุล
  // Case 2: D = คำนำหน้า (เด็กชาย/เด็กหญิง), E = ชื่อ นามสกุล
  // Case 3: D = ชื่อ นามสกุล, E = ว่าง
  const combined = [firstName, lastName]
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^(ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง)\s*/i, '')
    .trim();

  if (!combined) return '';
  const parts = combined.split(/\s+/).filter(Boolean);
  if (parts.length >= 3 && parts[parts.length - 2] === 'ณ') {
    return `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
  }
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return String(lastName || '').trim();
}

function autoDetectRules() {
  runAutoClassification(true);
  saveState();
  renderAll();
  showToast('✨ ตรวจสอบสีบุคลากร มช. (มช./ศรีพัฒน์) และคู่แฝด 7 คู่จากนามสกุลเรียบร้อยแล้ว');
}

// ==================== SEQUENTIAL 1-30 ROOM ASSIGNMENT & SWAPPING ====================

/**
 * ปุ่ม "⚡ แบ่งห้องเรียง 1 - 30 (6 ห้องประเมิน)"
 * เรียงรหัสผู้สมัครลงกลุ่ม 1 ถึง 30 ตามลำดับ แล้ววนขึ้นแถวใหม่ (เช่น คนที่ 1->กลุ่ม 1 ... คนที่ 30->กลุ่ม 30, คนที่ 31->กลุ่ม 1 ...)
 * ทำให้ 403 คน กระจายลง 30 กลุ่ม ได้กลุ่มละ 13-14 คนเท่าๆ กันในทุกห้องประเมิน (6 ห้อง × 5 รอบ)
 * และหลังจากแบ่งเสร็จ ผู้ใช้สามารถลากวางสลับรหัสผู้สมัครระหว่างกลุ่ม หรือลากทับรหัสอื่นเพื่อสลับที่ (Swap) กันได้ทันที!
 */
function assignSequentialRooms1To30() {
  if (appState.applicants.length === 0) {
    alert('ยังไม่มีข้อมูลรหัสผู้สมัคร กรุณาซิงค์ข้อมูลจาก Google Sheet ก่อนครับ');
    return;
  }

  const isStudentMode = appState.boardMode === 'student';
  if (isStudentMode) {
    // Ensure student groups 1..30 exist
    const default30 = getDefaultStudentGroups1To30();
    default30.forEach(g => {
      if (!appState.studentGroups.includes(g)) appState.studentGroups.push(g);
    });
  }

  const targetGroups = isStudentMode ? appState.studentGroups : appState.parentGroups;
  const groupField = isStudentMode ? 'studentGroup' : 'parentGroup';

  // Sort applicants by code in natural order before assigning 1..30
  const sortedApplicants = [...appState.applicants].sort((a, b) =>
    String(a.code).localeCompare(String(b.code), 'th', { numeric: true })
  );

  const groupCount = targetGroups.length;
  sortedApplicants.forEach((app, idx) => {
    const targetGroup = targetGroups[idx % groupCount];
    app[groupField] = targetGroup;
  });

  saveState();
  renderAll();
  showToast(`⚡ แบ่งห้องเรียงลำดับ 1 - ${groupCount} เรียบร้อยแล้ว (${sortedApplicants.length} คน) • สามารถลากวางสลับกันเองได้เลย!`);
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

async function fetchFromGoogleSheetUrl(sheetUrl, mergeExisting = true, silentOnFail = false) {
  const sheetId = extractSpreadsheetId(sheetUrl);
  const gid = extractGid(sheetUrl);
  appState.gsheetUrl = sheetUrl;

  setSyncBadge('saving', '⏳ กำลังดึงข้อมูลจาก Google Sheet...');
  showSheetStatus('กำลังเชื่อมต่อและอ่านข้อมูลคอลัมน์ A, D, E, F, L, S, Y จาก Google Sheet...', 'info');

  try {
    let rows = null;

    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      const response = await fetch(csvUrl, { cache: 'no-store' });
      if (response.ok) {
        const csvText = await response.text();
        if (csvText && !csvText.trim().startsWith('<!DOCTYPE html')) {
          const workbook = XLSX.read(csvText, { type: 'string' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
        }
      }
    } catch (_) {}

    if (!rows || rows.length === 0) {
      rows = await fetchSheetViaJsonp(sheetId, gid);
    }

    if (rows && rows.length > 0) {
      const importedCount = processSheetRows(rows, mergeExisting);
      if (importedCount > 0) {
        setSyncBadge('ok', `☁️ ซิงค์ Google Sheet แล้ว (${importedCount} รหัส)`);
        showSheetStatus(`✅ ดึงข้อมูลสำเร็จจำนวน ${importedCount} รหัสผู้สมัคร!`, 'success');
        showToast(`✅ ดึงข้อมูลจาก Google Sheet สำเร็จ (${importedCount} รหัส)`);
        return;
      }
    }

    throw new Error('ไม่พบแถวข้อมูลรหัสผู้สมัครในชีต หรือชีตยังไม่ได้เปิดสิทธิ์การเข้าถึง');
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

function fetchSheetViaJsonp(sheetId, gid = '0') {
  return new Promise((resolve, reject) => {
    const callbackName = 'gvizCallback_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
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

      const headerRow = cols.map(c => (c && c.label) ? String(c.label) : '');
      if (headerRow.some(h => h !== '')) {
        result.push(headerRow);
      }

      tableRows.forEach(r => {
        const cells = r.c || [];
        const rowArr = [];
        const maxLen = Math.max(cells.length, 26);
        for (let i = 0; i < maxLen; i++) {
          const cell = cells[i];
          if (!cell) {
            rowArr.push('');
          } else if (cell.f !== undefined && cell.f !== null) {
            rowArr.push(String(cell.f));
          } else if (cell.v !== undefined && cell.v !== null) {
            rowArr.push(String(cell.v));
          } else {
            rowArr.push('');
          }
        }
        result.push(rowArr);
      });

      resolve(result);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('ไม่สามารถโหลดสคริปต์ Google Sheet (ตรวจสอบสิทธิ์การแชร์ลิงก์)'));
    };

    script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json;responseHandler:${callbackName}&gid=${gid}`;
    document.body.appendChild(script);
  });
}

function processSheetRows(rows, mergeExisting = true) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const existingByCode = {};
  appState.applicants.forEach(a => {
    existingByCode[String(a.code).trim()] = a;
  });

  const firstRowStr = rows[0].map(c => String(c || '').trim()).join('|');
  const isExportedSummaryFormat =
    firstRowStr.includes('รหัสผู้สมัคร') &&
    firstRowStr.includes('กลุ่มนักเรียน') &&
    rows[0].length <= 12;

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
      importedParentGroup = String(row[9] || '').trim();
      importedNote = String(row[10] || '').trim();
    } else {
      firstName = String(row[3] !== undefined ? row[3] : '').trim();
      lastName = String(row[4] !== undefined ? row[4] : '').trim();
      nickname = String(row[5] !== undefined ? row[5] : '').trim();
      school = String(row[11] !== undefined ? row[11] : '').trim();
      parentName = String(row[18] !== undefined ? row[18] : '').trim();
      parentWork = String(row[24] !== undefined ? row[24] : '').trim();

      if (firstName === 'ชื่อ' || firstName === 'ชื่อนักเรียน' || school === 'โรงเรียน') {
        continue;
      }
    }

    const prev = existingByCode[rawCode];
    const item = {
      id: prev ? prev.id : ('app_' + Date.now() + '_' + i),
      code: rawCode,
      firstName: firstName || (prev ? prev.firstName : ''),
      lastName: lastName || (prev ? prev.lastName : ''),
      nickname: nickname || (prev ? prev.nickname : ''),
      school: school || (prev ? prev.school : ''),
      parentName: parentName || (prev ? prev.parentName : ''),
      parentWork: parentWork || (prev ? prev.parentWork : ''),
      category: importedCategory || (mergeExisting && prev ? prev.category : ''),
      manualCategory: importedCategory ? true : (mergeExisting && prev ? !!prev.manualCategory : false),
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
    if (mergeExisting) {
      const newCodeSet = new Set(newApplicants.map(a => a.code));
      appState.applicants.forEach(oldApp => {
        if (!newCodeSet.has(oldApp.code)) {
          newApplicants.push(oldApp);
        }
      });
    }
    appState.applicants = newApplicants;
    runAutoClassification(false);
    saveState();
    renderAll();
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

function renderAll() {
  renderHeaderSummaries();
  renderFilterCounts();
  renderBoardHeaderAndTabs();
  renderUnassignedPool();
  renderGroupsGrid();
}

function renderHeaderSummaries() {
  const total = appState.applicants.length;
  const studentAssigned = appState.applicants.filter(a => a.studentGroup && a.studentGroup.trim() !== '').length;
  const parentAssigned = appState.applicants.filter(a => a.parentGroup && a.parentGroup.trim() !== '').length;

  document.getElementById('student-board-summary').textContent = `จัดกลุ่มแล้ว ${studentAssigned} / ${total} คน`;
  document.getElementById('parent-board-summary').textContent = `จัดกลุ่มแล้ว ${parentAssigned} / ${total} คน`;

  document.getElementById('tab-student').classList.toggle('active', appState.boardMode === 'student');
  document.getElementById('tab-parent').classList.toggle('active', appState.boardMode === 'parent');
}

function renderFilterCounts() {
  const allCount = appState.applicants.length;
  const genCount = appState.applicants.filter(a => a.category === 'general').length;
  const sibCount = appState.applicants.filter(a => a.category === 'sibling').length;
  const cmuCount = appState.applicants.filter(a => a.category === 'cmu').length;
  const twinsCount = appState.applicants.filter(a => a.category && a.category.startsWith('twin_')).length;

  document.getElementById('count-all').textContent = allCount;
  document.getElementById('count-general').textContent = genCount;
  document.getElementById('count-sibling').textContent = sibCount;
  document.getElementById('count-cmu').textContent = cmuCount;
  document.getElementById('count-twins').textContent = twinsCount;

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
    banner.className = 'board-banner student-mode-banner';
    title.textContent = `👧👦 กระดานจัดกลุ่มสอบนักเรียน (${appState.studentGroups.length} กลุ่ม: ${firstG} - ${lastG} • 6 ห้องประเมิน)`;
    note.textContent = `เรียง ${firstG} - ${lastG} (ห้องละ 12-14 คน) • ลากรหัสไปวางกลุ่มอื่น หรือลากทับรหัสอื่นเพื่อสลับกลุ่มกันได้ทันที`;
    modeLabel.textContent = `นักเรียน ${firstG}-${lastG}`;
    renderSubGroupTabsForStudent();
  } else {
    banner.className = 'board-banner parent-mode-banner';
    title.textContent = `👨‍👩‍👧 กระดานจัดกลุ่มผู้ปกครอง (${appState.parentGroups.length} กลุ่ม)`;
    note.textContent = 'วัน/เวลาสอบผู้ปกครอง • ลากรหัสไปวางกลุ่มอื่น หรือลากทับรหัสอื่นเพื่อสลับกลุ่มได้ทันที';
    modeLabel.textContent = 'ผู้ปกครอง A1-O3';
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

/**
 * สร้างป้ายรหัสผู้สมัคร (แสดงเฉพาะรหัสผู้สมัครเท่านั้น)
 * รองรับทั้ง:
 * - ลากไปวางในกล่องกลุ่มเพื่อย้ายกลุ่ม
 * - ลากไปวางทับป้ายรหัสของอีกคนเพื่อ "สลับกลุ่มกัน (Swap)" ได้ทันที!
 */
function createApplicantChipElement(applicant) {
  const chip = document.createElement('div');
  const catClass = `cat-${applicant.category || 'general'}`;
  chip.className = `code-chip ${catClass}`;
  chip.draggable = true;
  chip.dataset.id = applicant.id;
  chip.textContent = applicant.code;

  // Drag events
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

    saveState();
    renderAll();
    showToast(`🔄 สลับกลุ่มระหว่างรหัส ${sourceApp.code} กับ ${applicant.code} เรียบร้อยแล้ว`);
  });

  // Hover events -> Show floating rich tooltip
  chip.addEventListener('mouseenter', (e) => {
    showHoverTooltip(e, applicant);
  });

  chip.addEventListener('mousemove', (e) => {
    moveHoverTooltip(e);
  });

  chip.addEventListener('mouseleave', () => {
    hideHoverTooltip();
  });

  // Click event -> Open modal to change color or edit details
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    hideHoverTooltip();
    openEditApplicantModal(applicant.id);
  });

  return chip;
}

function renderUnassignedPool() {
  const container = document.getElementById('unassigned-container');
  container.innerHTML = '';

  const groupField = appState.boardMode === 'student' ? 'studentGroup' : 'parentGroup';
  const unassignedList = appState.applicants.filter(a => {
    const g = a[groupField] || '';
    return g === '' && matchesSearchAndCategory(a);
  });

  document.getElementById('unassigned-count').textContent = unassignedList.length;

  if (unassignedList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-empty-hint';
    empty.textContent = 'ไม่มีรหัสในช่องนี้';
    container.appendChild(empty);
    return;
  }

  unassignedList.forEach(app => {
    container.appendChild(createApplicantChipElement(app));
  });
}

function renderGroupsGrid() {
  const grid = document.getElementById('groups-grid');
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

    const members = appState.applicants.filter(a => a[groupField] === groupName && matchesSearchAndCategory(a));
    const totalMembersInGroup = appState.applicants.filter(a => a[groupField] === groupName).length;

    let roomTagHtml = '';
    if (isStudentMode) {
      const roomInfo = getEvalRoomInfo(groupName);
      if (roomInfo) {
        roomTagHtml = `<span class="room-sub-tag">${escapeHtml(roomInfo.label)}</span>`;
      }
    }

    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `
      <div class="group-title">
        <span>กลุ่ม ${escapeHtml(groupName)}</span>
        ${roomTagHtml}
      </div>
      <span class="group-count">${totalMembersInGroup} คน</span>
    `;

    const body = document.createElement('div');
    body.className = 'group-body';

    if (members.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'group-empty-hint';
      hint.textContent = 'ลากรหัสผู้สมัครมาวางที่นี่';
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

  tooltip.innerHTML = `
    <div class="tooltip-header">
      <span class="tooltip-code">รหัส: ${escapeHtml(applicant.code)}</span>
      <span class="tooltip-cat-badge" style="background:${meta.badgeBg};color:${meta.badgeColor};">${escapeHtml(meta.label)}</span>
    </div>
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

  const ln = normalizeLastName(applicant.lastName, applicant.firstName);
  const alertBox = document.getElementById('same-lastname-alert');
  if (ln) {
    const matches = appState.applicants.filter(a => a.id !== applicant.id && normalizeLastName(a.lastName, a.firstName) === ln);
    if (matches.length > 0) {
      const matchDesc = matches.map(m => `รหัส ${m.code} (${m.firstName} ${m.lastName})`).join(', ');
      alertBox.innerHTML = `👯 <strong>พบนามสกุล "${escapeHtml(ln)}" เหมือนกับ:</strong> ${escapeHtml(matchDesc)}`;
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
    // Auto-generate next alphabetical group (e.g. after Z -> AA, after AD -> AE)
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
    ? '⚙️ จัดการกลุ่มสอบนักเรียน (1 - 30 / A - Z)'
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
  showToast('ตั้งกลุ่มนักเรียนเป็น 1 - 30 (30 กลุ่ม • 6 ห้องประเมิน) เรียบร้อยแล้ว');
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
      ? '🎲 จัดแบ่งกลุ่มนักเรียนอัตโนมัติ (1 - 30)'
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

  // Default: random_even with twin rule
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
  const label = appState.boardMode === 'student' ? 'กลุ่มนักเรียน (1-30)' : 'กลุ่มผู้ปกครอง (A1-O3)';
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

function scheduleCloudSave() {
  if (!appState.appsScriptUrl) return;
  if (cloudSaveTimeout) clearTimeout(cloudSaveTimeout);
  cloudSaveTimeout = setTimeout(() => {
    pushStateToCloudNow(true);
  }, 1500);
}

async function pushStateToCloudNow(silent = false) {
  const url = document.getElementById('apps-script-url-input')?.value.trim() || appState.appsScriptUrl;
  if (!url) {
    if (!silent) alert('กรุณาวาง Web App URL จาก Google Apps Script ก่อนครับ');
    return;
  }
  appState.appsScriptUrl = url;
  setSyncBadge('saving', '☁️ กำลังบันทึกออนไลน์...');

  try {
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      studentGroups: appState.studentGroups,
      parentGroups: appState.parentGroups,
      applicants: appState.applicants
    });

    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload
    });

    setSyncBadge('ok', '☁️ บันทึกออนไลน์แล้ว');
    if (!silent) showToast('☁️ บันทึกสถานะการจัดกลุ่มและสีขึ้น Google Sheet ออนไลน์เรียบร้อยแล้ว');
  } catch (err) {
    console.warn('Cloud push error:', err);
    setSyncBadge('ready', '☁️ เชื่อมต่อ Google Sheet');
    if (!silent) showToast('⚠️ ไม่สามารถบันทึกออนไลน์ได้ กรุณาตรวจสอบ Web App URL');
  }
}

async function pullStateFromCloudNow(silent = false) {
  const url = document.getElementById('apps-script-url-input')?.value.trim() || appState.appsScriptUrl;
  if (!url) {
    if (!silent) alert('กรุณาวาง Web App URL จาก Google Apps Script ก่อนครับ');
    return;
  }
  appState.appsScriptUrl = url;
  setSyncBadge('saving', '⏳ กำลังโหลดจาก Cloud...');

  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}action=loadState`, { cache: 'no-store' });
    const data = await res.json();
    if (data && Array.isArray(data.applicants) && data.applicants.length > 0) {
      appState.applicants = data.applicants;
      if (Array.isArray(data.studentGroups)) appState.studentGroups = data.studentGroups;
      if (Array.isArray(data.parentGroups)) appState.parentGroups = data.parentGroups;
      saveState(false);
      renderAll();
      setSyncBadge('ok', '☁️ ซิงค์ Cloud ล่าสุดแล้ว');
      if (!silent) showToast('📥 โหลดสถานะการจัดกลุ่มจาก Cloud เรียบร้อยแล้ว');
    }
  } catch (err) {
    console.warn('Cloud pull error:', err);
    setSyncBadge('ready', '☁️ เชื่อมต่อ Google Sheet');
  }
}

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
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' });
      const count = processSheetRows(rows, mergeExisting);
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

  // Sheet 1: All Applicants Master Table
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
      'กลุ่มนักเรียน (1-30)': a.studentGroup || 'ยังไม่จัดกลุ่ม',
      'ห้องประเมิน (1-6)': roomInfo ? roomInfo.label : '-',
      'กลุ่มผู้ปกครอง (A1-O3)': a.parentGroup || 'ยังไม่จัดกลุ่ม',
      'หมายเหตุ': a.note || ''
    };
  });
  const wsMaster = XLSX.utils.json_to_sheet(masterRows);
  XLSX.utils.book_append_sheet(wb, wsMaster, 'รวมทั้งหมด');

  // Sheet 2: Sorted by Student Groups (1 - 30)
  const studentSorted = [...appState.applicants].sort((a, b) => {
    if (!a.studentGroup && b.studentGroup) return 1;
    if (a.studentGroup && !b.studentGroup) return -1;
    return String(a.studentGroup).localeCompare(String(b.studentGroup), 'en', { numeric: true }) ||
           String(a.code).localeCompare(String(b.code), 'en', { numeric: true });
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
  XLSX.utils.book_append_sheet(wb, wsStudent, 'กลุ่มนักเรียน (1-30)');

  // Sheet 3: Sorted by Parent Groups (A1 - O3)
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
