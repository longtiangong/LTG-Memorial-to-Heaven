const API_KEY = PropertiesService.getScriptProperties().getProperty("GAS_API_KEY");

function authorizeDriveAccess() {
  DriveApp.getRootFolder().getName();
}

function authorizeExternalRequest() {
  const response = UrlFetchApp.fetch("https://www.google.com/robots.txt", {
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(
      `外部請求授權測試失敗：HTTP ${response.getResponseCode()}`
    );
  }
}

function authorizeSpreadsheetAccess() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_500_ID");
  if (!sheetId) {
    throw new Error("請先從 Streamlit 呼叫一次產生流程，讓系統記錄試算表 ID。");
  }
  SpreadsheetApp.openById(sheetId).getName();
}

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    
    // 驗證 API Key
    if (contents.apiKey !== API_KEY) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unauthorized: Invalid API Key" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const sheetId = contents.sheetId;
    const docTitle = contents.docTitle || "500元光明燈疏文";
    PropertiesService.getScriptProperties().setProperty("SHEET_500_ID", sheetId);
    
    // 執行疏文生成
    const files = generateShuWenDoc(sheetId, docTitle);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      url: files.docUrl,
      wordUrl: files.wordUrl,
      wordDownloadUrl: files.wordDownloadUrl,
    }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function generateShuWenDoc(sheetId, docTitle) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName("500元光明燈");
  if (!sheet) throw new Error("找不到『500元光明燈』工作表");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error("試算表沒有可產生的資料");

  data.shift();
  if (sheet.getLastColumn() < 9) {
    throw new Error("『500元光明燈』工作表至少需要 A 至 I 欄");
  }

  const columns = {
    light1Number: 0, // A欄：光明燈1號碼
    light2Number: 1, // B欄：光明燈2號碼
    address: 2,      // C欄：住址
    gender: 3,       // D欄：信士女
    name: 4,         // E欄：姓名
    birthDate: 5,    // F欄：出生年月日
    birthTime: 6,    // G欄：生時
    light1Type: 7,   // H欄：光明燈1種類
    light2Type: 8,   // I欄：光明燈2種類
  };

  const timezone = ss.getSpreadsheetTimeZone();
  const groups = [];
  const groupsByAddress = new Map();
  data.forEach(row => {
    const address = normalizeAddress(getCellText(row[columns.address], timezone));
    const member = [
      getCellText(row[columns.light1Number], timezone),
      getCellText(row[columns.light2Number], timezone),
      getCellText(row[columns.gender], timezone),
      getCellText(row[columns.name], timezone),
      getCellText(row[columns.birthDate], timezone, "yyyy年MM月dd日"),
      getCellText(row[columns.birthTime], timezone, "HH:mm"),
      getCellText(row[columns.light1Type], timezone),
      getCellText(row[columns.light2Type], timezone),
    ];
    if (member.every(value => !value)) return;

    const addressKey = address || "未提供地址";
    let group = groupsByAddress.get(addressKey);
    if (!group) {
      group = { address: addressKey, members: [] };
      groupsByAddress.set(addressKey, group);
      groups.push(group);
    }
    group.members.push(member);
  });
  if (groups.length === 0) throw new Error("找不到可產生的光明燈資料");

  const doc = DocumentApp.create(docTitle);
  const body = doc.getBody();

  body.setPageWidth(841.89);
  body.setPageHeight(1190.55);
  body.setMarginTop(56.69);
  body.setMarginBottom(56.69);
  body.setMarginLeft(56.69);
  body.setMarginRight(56.69);
  appendAddressGroups(body, groups);

  doc.saveAndClose();
  const wordFile = createA3PortraitWordFile(groups, docTitle);
  return {
    docUrl: doc.getUrl(),
    wordUrl: wordFile.getUrl(),
    wordDownloadUrl: `https://drive.google.com/uc?export=download&id=${wordFile.getId()}`,
  };
}

function appendAddressGroups(body, groups) {
  const pageCapacity = 1040;
  const leftWidth = 335.91;
  const middleGap = 56.69;
  let page = [];
  let currentColumn = 0;
  let usedHeight = [0, 0];
  let hasPage = false;

  function flushPage() {
    if (page.length === 0) return;
    if (hasPage) body.appendPageBreak();
    const layout = body.appendTable([["", "", ""]]);
    layout.setBorderWidth(0);
    layout.setColumnWidth(0, leftWidth);
    layout.setColumnWidth(1, middleGap);
    layout.setColumnWidth(2, leftWidth);
    page.forEach(item => appendAddressGroup(layout.getCell(0, item.column === 0 ? 0 : 2), item.group));
    hasPage = true;
    page = [];
    currentColumn = 0;
    usedHeight = [0, 0];
  }

  groups.forEach(group => {
    group.fontSize = getAddressGroupFontSize(group, pageCapacity);
    const height = estimateAddressGroupHeight(group, group.fontSize);
    if (!height || height > pageCapacity) {
      throw new Error(
        `住址「${group.address}」的資料即使縮至 8 pt 仍無法完整放在同一頁。`
      );
    }
    if (usedHeight[currentColumn] + height > pageCapacity) currentColumn++;
    if (currentColumn > 1) {
      flushPage();
    }
    page.push({ group, column: currentColumn });
    usedHeight[currentColumn] += height;
  });
  flushPage();
}

function getAddressGroupFontSize(group, pageCapacity) {
  // * 11092332 預設字體16 pt，資料欄相鄰間距 3 pt
  for (let fontSize = 16; fontSize >= 8; fontSize--) {
    if (estimateAddressGroupHeight(group, fontSize) <= pageCapacity) {
      return fontSize;
    }
  }
  return 8;
}

function estimateAddressGroupHeight(group, fontSize) {
  const addressLines = estimateWrappedLines(group.address, 335.91, fontSize);
  const fieldWidth = 335.91 / 8 - 3;
  const rowsHeight = group.members.reduce((total, member) => {
    const lineCount = Math.max(
      ...member.map(value => estimateWrappedLines(value, fieldWidth, fontSize))
    );
    return total + lineCount * fontSize * 1.2;
  }, 0);
  return addressLines * fontSize * 1.2 + rowsHeight;
}

function estimateWrappedLines(value, width, fontSize) {
  const textWidth = Array.from(value || "").reduce((total, character) => {
    return total + (/[^\u0000-\u00ff]/.test(character) ? fontSize : fontSize * 0.55);
  }, 0);
  return Math.max(1, Math.ceil(textWidth / width));
}

function normalizeAddress(address) {
  return String(address || "").replace(/[\s\u3000]+/g, "").trim();
}

function appendAddressGroup(container, group) {
  const addressLine = container.appendTable([[group.address]]);
  addressLine.setBorderWidth(0);
  addressLine.setColumnWidth(0, 335.91);
  const addressCell = addressLine.getCell(0, 0);
  addressCell.setPaddingTop(0);
  addressCell.setPaddingBottom(0);
  addressCell.setPaddingLeft(0);
  addressCell.setPaddingRight(0);
  addressCell.editAsText().setFontSize(group.fontSize).setBold(true);

  group.members.forEach(member => {
    const row = container.appendTable([member]);
    row.setBorderWidth(0);
    for (let column = 0; column < member.length; column++) {
      const cell = row.getCell(0, column);
      cell.setWidth(335.91 / 8);
      cell.setPaddingTop(0);
      cell.setPaddingBottom(0);
      // * 11092332 預設字體16 pt，資料欄相鄰間距 3 pt
      cell.setPaddingLeft(1.5);
      cell.setPaddingRight(1.5);
      cell.editAsText().setFontSize(group.fontSize);
    }
  });
}

function createA3PortraitWordFile(groups, docTitle) {
  const wordDoc = DocumentApp.create(`${docTitle}_A3直式`);
  try {
    const body = wordDoc.getBody();
    body.setPageWidth(841.89);
    body.setPageHeight(1190.55);
    body.setMarginTop(56.69);
    body.setMarginBottom(56.69);
    body.setMarginLeft(56.69);
    body.setMarginRight(56.69);
    appendAddressGroups(body, groups);

    wordDoc.saveAndClose();
    const exportResponse = UrlFetchApp.fetch(
      `https://docs.google.com/document/d/${wordDoc.getId()}/export?format=docx`,
      {
        headers: {
          Authorization: `Bearer ${ScriptApp.getOAuthToken()}`,
        },
        muteHttpExceptions: true,
      }
    );
    if (exportResponse.getResponseCode() !== 200) {
      throw new Error(
        `Google 文件匯出 Word 失敗 (${exportResponse.getResponseCode()}): ` +
        exportResponse.getContentText().slice(0, 500)
      );
    }

    const blob = exportResponse.getBlob()
      .setContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .setName(`${docTitle}_A3直式.docx`);
    const signature = blob.getBytes();
    if (signature.length < 2 || signature[0] !== 80 || signature[1] !== 75) {
      throw new Error("Google 文件匯出結果不是有效的 Word（DOCX）檔案");
    }

    const rotatedBlob = rotateWordTableText(blob);
    const wordFile = DriveApp.createFile(rotatedBlob);
    DriveApp.getFileById(wordDoc.getId()).setTrashed(true);
    return wordFile;
  } catch (error) {
    DriveApp.getFileById(wordDoc.getId()).setTrashed(true);
    throw error;
  }
}

// * 11092304 Word 文字270 度旋轉：更新 DOCX XML 的儲存格文字方向。
function rotateWordTableText(docxBlob) {
  const zipBlob = docxBlob.copyBlob().setContentType("application/zip");
  const entries = Utilities.unzip(zipBlob);
  let documentXmlFound = false;
  const updatedEntries = entries.map(entry => {
    if (entry.getName() !== "word/document.xml") return entry;
    documentXmlFound = true;
    const xmlDocument = XmlService.parse(entry.getDataAsString("UTF-8"));
    const root = xmlDocument.getRootElement();
    const wordNamespace = root.getNamespace();
    rotateTextCells(root, wordNamespace);
    return Utilities.newBlob(
      XmlService.getRawFormat().format(xmlDocument),
      MimeType.XML,
      entry.getName()
    );
  });
  if (!documentXmlFound) throw new Error("Word 檔缺少 document.xml，無法旋轉文字");
  return Utilities.zip(updatedEntries, docxBlob.getName())
    .setContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

function rotateTextCells(element, wordNamespace) {
  if (element.getName() === "tc") {
    const hasText = element.getChildren("p", wordNamespace)
      .some(paragraph => getXmlText(paragraph).trim() !== "");
    if (hasText) {
      let properties = element.getChild("tcPr", wordNamespace);
      if (!properties) {
        properties = XmlService.createElement("tcPr", wordNamespace);
        element.addContent(0, properties);
      }
      let direction = properties.getChild("textDirection", wordNamespace);
      if (!direction) {
        direction = XmlService.createElement("textDirection", wordNamespace);
        properties.addContent(direction);
      }
      direction.setAttribute("val", "btLr", wordNamespace);
    }
  }
  element.getChildren().forEach(child => rotateTextCells(child, wordNamespace));
}

function getXmlText(element) {
  let text = element.getText() || "";
  element.getChildren().forEach(child => {
    text += getXmlText(child);
  });
  return text;
}

function getCellText(value, timezone, datePattern) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, timezone, datePattern || "yyyy年MM月dd日");
  }
  return value == null ? "" : String(value).trim();
}
