/**
 * AI Automation — Thư viện tài liệu → Google Sheet + Google Drive
 *
 * CÁCH DÙNG:
 * 1) Tạo 1 Google Sheet mới.
 * 2) Extensions → Apps Script → dán toàn bộ file này.
 * 3) Deploy → New deployment → Type: Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Authorize (cấp quyền gồm Google Drive).
 * 4) Copy URL "…/exec" → đặt vào biến môi trường GSHEET_WEBHOOK_URL của app.
 *
 * FOLDER GỐC trên Drive: "AI Thư viện" (đổi ở biến ROOT_FOLDER bên dưới nếu muốn).
 */

var ROOT_FOLDER = 'AI Thư viện';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Links') || ss.insertSheet('Links');
    if (sh.getLastRow() === 0) {
      sh.appendRow(['Thời gian', 'Module', 'Bài học', 'Loại', 'Tiêu đề', 'Link', 'Ảnh', 'Tags', 'Ghi chú', 'ID']);
      sh.getRange('A1:J1').setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.setColumnWidth(7, 240);
    }

    var d = JSON.parse(e.postData.contents);

    // Xoá dữ liệu (giữ tiêu đề) để "Đồng bộ tất cả" ghi lại toàn bộ không trùng
    if (d.action === 'reset') {
      if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
      return json_({ ok: true, reset: true });
    }

    var driveLinks = [], imageFormula = '';
    if (d.images && d.images.length) {
      var root = getFolder_(DriveApp.getRootFolder(), ROOT_FOLDER);
      var subName = ((d.module ? d.module + ' - ' : '') + (d.lesson || 'Chung')).replace(/[\/]/g, ' ').slice(0, 120);
      var folder = getFolder_(root, subName);
      for (var i = 0; i < d.images.length; i++) {
        var img = d.images[i];
        var name = img.name || ('image_' + Date.now() + '.png');
        var file;
        var ex = folder.getFilesByName(name);          // tái dùng nếu đã có → không nhân bản
        if (ex.hasNext()) {
          file = ex.next();
        } else {
          file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(img.base64), img.mime || 'image/png', name));
          try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) {}
        }
        var id = file.getId();
        driveLinks.push('https://drive.google.com/file/d/' + id + '/view');
        if (!imageFormula) imageFormula = '=IMAGE("https://drive.google.com/thumbnail?id=' + id + '&sz=w600")';
      }
    }

    var linkCell = driveLinks.length ? driveLinks.join('\n') : (d.url || '');
    sh.appendRow([
      d.time || new Date().toISOString(),
      d.module || '', d.lesson || '', d.type || '', d.title || '',
      linkCell, '', d.tags || '', d.note || '', d.id || ''
    ]);
    var row = sh.getLastRow();
    if (imageFormula) { sh.getRange(row, 7).setFormula(imageFormula); sh.setRowHeight(row, 120); }

    return json_({ ok: true, drive: driveLinks });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function getFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
