const API_KEY = PropertiesService.getScriptProperties().getProperty("GAS_API_KEY");

function authorizeDriveAccess() {
  DriveApp.getRootFolder().getName();
}

function authorizeSpreadsheetAccess() {
  const properties = PropertiesService.getScriptProperties();
  const sheetIds = ["SHEET_500_ID", "SHEET_300_ID"]
    .map(propertyName => properties.getProperty(propertyName))
    .filter(Boolean);
  if (sheetIds.length === 0) {
    throw new Error("請先從 Streamlit 呼叫一次產生流程，讓系統記錄試算表 ID。");
  }
  sheetIds.forEach(sheetId => SpreadsheetApp.openById(sheetId).getName());
}

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    
    // 驗證 API Key
    if (typeof API_KEY !== "string" || !API_KEY || contents.apiKey !== API_KEY) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unauthorized: Invalid API Key" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (contents.action === "verify") {
      return createJsonResponse(verifyLampPlacement(contents));
    }
    if (contents.action === "check_updates") {
      return createJsonResponse(checkLampUpdates(contents));
    }
    
    const lampType = contents.lampType || "500";
    const lampOptions = {
      "300": {
        propertyName: "SHEET_300_ID",
        sheetName: "300元光明燈",
        defaultDocTitle: "300元光明燈疏文",
      },
      "500": {
        propertyName: "SHEET_500_ID",
        sheetName: "500元光明燈",
        defaultDocTitle: "500元光明燈疏文",
      },
    };
    if (!Object.prototype.hasOwnProperty.call(lampOptions, lampType)) {
      throw new Error("不支援的光明燈金額");
    }
    const lampOption = lampOptions[lampType];

    const sheetId = contents.sheetId ||
      PropertiesService.getScriptProperties().getProperty(lampOption.propertyName);
    if (!sheetId) throw new Error(`請設定 ${lampOption.propertyName}`);
    const docTitle = contents.docTitle || lampOption.defaultDocTitle;
    const wordFolderId = contents.wordFolderId;
    if (!wordFolderId) throw new Error("請設定 WORD_FOLDER_ID");
    PropertiesService.getScriptProperties().setProperty(lampOption.propertyName, sheetId);

    // 執行疏文生成
    const files = generateWordDocument(sheetId, docTitle, lampOption.sheetName, wordFolderId);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      wordUrl: files.wordUrl,
      wordDownloadUrl: files.wordDownloadUrl,
    }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function createJsonResponse(result) {
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function getLampSheets(sheetIds) {
  if (!sheetIds || !sheetIds["300"] || !sheetIds["500"]) {
    throw new Error("請確認 Secrets 已設定 SHEET_300_ID 與 SHEET_500_ID");
  }
  return ["300", "500"].map(tier => {
    const sheetName = `${tier}元光明燈`;
    const sheet = SpreadsheetApp.openById(sheetIds[tier]).getSheetByName(sheetName);
    if (!sheet) throw new Error(`找不到「${sheetName}」工作表`);
    return { tier, sheetName, sheet };
  });
}

function normalizeCheckValue(value) {
  return String(value == null ? "" : value).trim();
}

function getPlacementAuditColumns(sheet) {
  const headers = [
    "_上架確認_號碼姓名",
    "_上架確認_號碼2",
    "_上架確認_燈名1",
    "_上架確認_燈名2",
    "_上架確認_時間",
  ];
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const existingHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const positions = headers.map(header => existingHeaders.indexOf(header) + 1);
  const isContiguous = positions.every((column, index) =>
    column > 0 && (index === 0 || column === positions[0] + index)
  );
  const startColumn = isContiguous
    ? positions[0]
    : Math.max(14, lastColumn + 1);

  if (!isContiguous) {
    sheet.getRange(1, startColumn, 1, headers.length).setValues([headers]);
    sheet.hideColumns(startColumn, headers.length);
  }
  const statusHeaders = [
    "確認光明燈1號碼及姓名",
    "確認光明燈2號碼",
    "確認光明燈1種類",
    "確認光明燈2種類",
  ];
  statusHeaders.forEach((header, index) => {
    const cell = sheet.getRange(1, 10 + index);
    if (!cell.getDisplayValue()) cell.setValue(header);
  });
  return startColumn;
}

function getPlacementCandidate(sheets, number1, name, number2) {
  const candidates = [];
  sheets.forEach(target => {
    const lastRow = target.sheet.getLastRow();
    if (lastRow < 2) return;
    const rows = target.sheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
    rows.forEach((row, index) => {
      const rowNumber1 = normalizeCheckValue(row[0]);
      const rowNumber2 = normalizeCheckValue(row[1]);
      const rowName = normalizeCheckValue(row[4]);
      if (
        (number1 && rowNumber1 === number1) ||
        (name && rowName === name) ||
        (number2 && rowNumber2 === number2)
      ) {
        const score =
          (number1 && rowNumber1 === number1 ? 4 : 0) +
          (name && rowName === name ? 4 : 0) +
          (number2 && rowNumber2 === number2 ? 2 : 0);
        candidates.push({
          target,
          rowNumber: index + 2,
          row,
          score,
        });
      }
    });
  });
  if (candidates.length === 0) return null;

  const highestScore = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.score),
    -Infinity
  );
  const bestCandidates = candidates.filter(candidate => candidate.score === highestScore);
  return bestCandidates.length === 1 ? bestCandidates[0] : null;
}

function verifyLampPlacement(contents) {
  const number1 = normalizeCheckValue(contents.number1 || contents.number);
  const number2 = normalizeCheckValue(contents.number2);
  const name = normalizeCheckValue(contents.name);
  const lightType1 = normalizeCheckValue(contents.light_type1 || contents.light_type);
  const lightType2 = normalizeCheckValue(contents.light_type2);
  const sheets = getLampSheets(contents.sheetIds);
  const candidate = getPlacementCandidate(sheets, number1, name, number2);
  if (!candidate) {
    return {
      status: "fail",
      errors: ["號碼", "姓名"],
      message: "找不到唯一符合的資料列，請確認號碼及姓名",
    };
  }

  const row = candidate.row;
  const number1Matches = Boolean(number1) && normalizeCheckValue(row[0]) === number1;
  const nameMatches = Boolean(name) && normalizeCheckValue(row[4]) === name;
  const number2Matches = normalizeCheckValue(row[1]) === number2;
  const lightType1Matches =
    Boolean(lightType1) && normalizeCheckValue(row[7]) === lightType1;
  const lightType2Matches = normalizeCheckValue(row[8]) === lightType2;
  const checks = [
    number1Matches && nameMatches,
    number2Matches,
    lightType1Matches,
    lightType2Matches,
  ];
  const auditColumn = getPlacementAuditColumns(candidate.target.sheet);
  const errors = [];
  if (!number1Matches) errors.push("號碼");
  if (!nameMatches) errors.push("姓名");
  if (!number2Matches) errors.push("號碼2");
  if (!lightType1Matches) errors.push("燈名");
  if (!lightType2Matches) errors.push("燈名2");

  const statuses = checks.map(matches => matches ? "🟢" : "🟡");
  candidate.target.sheet
    .getRange(candidate.rowNumber, 10, 1, 4)
    .setValues([statuses])
    .setBackgrounds([checks.map(matches => matches ? "#d9ead3" : "#ffe599")])
    .setHorizontalAlignment("CENTER");

  if (errors.length > 0) {
    return {
      status: "fail",
      errors,
      sheetName: candidate.target.sheetName,
      rowNumber: candidate.rowNumber,
    };
  }

  const snapshot = [
    JSON.stringify([normalizeCheckValue(row[0]), normalizeCheckValue(row[4])]),
    normalizeCheckValue(row[1]),
    normalizeCheckValue(row[7]),
    normalizeCheckValue(row[8]),
    new Date(),
  ];
  candidate.target.sheet
    .getRange(candidate.rowNumber, auditColumn, 1, snapshot.length)
    .setValues([snapshot]);
  return {
    status: "success",
    sheetName: candidate.target.sheetName,
    rowNumber: candidate.rowNumber,
  };
}

function checkLampUpdates(contents) {
  const sheets = getLampSheets(contents.sheetIds);
  let totalChangedRows = 0;
  const results = sheets.map(target => {
    const sheet = target.sheet;
    const auditColumn = getPlacementAuditColumns(sheet);
    const lastRow = sheet.getLastRow();
    let changedRows = 0;
    if (lastRow < 2) return { sheetName: target.sheetName, changedRows };

    const rowCount = lastRow - 1;
    const data = sheet.getRange(2, 1, rowCount, 9).getDisplayValues();
    const auditData = sheet.getRange(2, auditColumn, rowCount, 5).getValues();
    const statusRange = sheet.getRange(2, 10, rowCount, 4);
    const statusesByRow = statusRange.getDisplayValues();
    data.forEach((row, index) => {
      if (row.every(value => !normalizeCheckValue(value))) return;
      const current = [
        JSON.stringify([normalizeCheckValue(row[0]), normalizeCheckValue(row[4])]),
        normalizeCheckValue(row[1]),
        normalizeCheckValue(row[7]),
        normalizeCheckValue(row[8]),
      ];
      const previous = auditData[index];
      const isUnverified = !previous[4];
      const changed = isUnverified
        ? [true, true, true, true]
        : current.map((value, fieldIndex) => value !== normalizeCheckValue(previous[fieldIndex]));
      if (!changed.some(Boolean)) return;

      changed.forEach((isChanged, fieldIndex) => {
        if (isChanged && statusesByRow[index][fieldIndex] !== "🟡") {
          statusesByRow[index][fieldIndex] = "🔴";
        }
      });
      changedRows += 1;
    });
    statusRange
      .setValues(statusesByRow)
      .setBackgrounds(statusesByRow.map(statuses => statuses.map(status =>
        status === "🔴" ? "#f4cccc" :
          status === "🟢" ? "#d9ead3" :
            status === "🟡" ? "#ffe599" : "#ffffff"
      )))
      .setHorizontalAlignment("CENTER");
    totalChangedRows += changedRows;
    return { sheetName: target.sheetName, changedRows };
  });

  return {
    status: "success",
    has_updates: totalChangedRows > 0,
    changedRows: totalChangedRows,
    sheets: results,
  };
}

function generateWordDocument(sheetId, docTitle, sheetName, wordFolderId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`找不到『${sheetName}』工作表`);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) throw new Error("試算表沒有可產生的資料");

  data.shift();
  if (sheet.getLastColumn() < 9) {
    throw new Error(`『${sheetName}』工作表至少需要 A 至 I 欄`);
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

  const wordFile = createA3PortraitWordFile(groups, docTitle, wordFolderId);
  return {
    wordUrl: wordFile.getUrl(),
    wordDownloadUrl: `https://drive.google.com/uc?export=download&id=${wordFile.getId()}`,
  };
}

function buildWordDocumentXml(groups) {
  const contentWidth = 728.51;
  const pageHeightTwips = 23811;
  const pageMarginTwips = 1134;
  const centerGapTwips = 850;
  const halfCapacityTwips = Math.floor(
    (pageHeightTwips - pageMarginTwips * 2 - centerGapTwips) / 2
  );
  const regionCapacity = halfCapacityTwips / 20 - 100;
  const pages = [];
  let pageGroups = [];
  let pageHeight = 0;

  groups.forEach(group => {
    group.fontSize = getAddressGroupFontSize(group, regionCapacity, contentWidth);
    const height = estimateAddressGroupHeight(group, group.fontSize, contentWidth);
    if (height > regionCapacity) {
      throw new Error(
        `地址「${group.address}」的 ${group.members.length} 筆資料無法在 A3 中央留白區一側完整排入，` +
        "請減少同址資料或調整版面後再產生。"
      );
    }

    const nextPageGroups = pageGroups.concat(group);
    if (
      pageGroups.length > 0 &&
      (
        pageHeight + height > regionCapacity * 2 ||
        !splitAddressGroupsAcrossPage(nextPageGroups, regionCapacity, contentWidth)
      )
    ) {
      pages.push(splitAddressGroupsAcrossPage(pageGroups, regionCapacity, contentWidth));
      pageGroups = [];
      pageHeight = 0;
    }
    pageGroups.push(group);
    pageHeight += height;
  });
  if (pageGroups.length > 0) {
    pages.push(splitAddressGroupsAcrossPage(pageGroups, regionCapacity, contentWidth));
  }

  const content = [];
  const columnWidths = getMemberColumnWidths();
  pages.forEach((currentPage, index) => {
    content.push(buildWordPageTable(
      currentPage,
      columnWidths,
      halfCapacityTwips,
      centerGapTwips,
      index > 0
    ));
  });

  const section = [
    '<w:sectPr>',
    `<w:pgSz w:w="16838" w:h="${pageHeightTwips}"/>`,
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/>',
    '</w:sectPr>',
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${content.join("")}${section}</w:body></w:document>`;
}

function splitAddressGroupsAcrossPage(groups, regionCapacity, contentWidth) {
  const heights = groups.map(group => {
    return estimateAddressGroupHeight(group, group.fontSize, contentWidth);
  });
  const totalHeight = heights.reduce((total, height) => total + height, 0);
  const firstSplit = 1;
  const lastSplit = Math.max(1, groups.length - 1);
  let bestSplit = -1;
  let bestDifference = Infinity;
  let topHeight = 0;

  for (let split = 0; split <= groups.length; split++) {
    const bottomHeight = totalHeight - topHeight;
    if (
      split >= firstSplit &&
      split <= lastSplit &&
      topHeight <= regionCapacity &&
      bottomHeight <= regionCapacity
    ) {
      const difference = Math.abs(topHeight - bottomHeight);
      if (difference < bestDifference) {
        bestSplit = split;
        bestDifference = difference;
      }
    }
    if (split < groups.length) topHeight += heights[split];
  }

  if (bestSplit < 0) return null;
  return {
    topGroups: groups.slice(0, bestSplit),
    bottomGroups: groups.slice(bestSplit),
    topHeight: heights.slice(0, bestSplit).reduce((total, height) => total + height, 0),
    bottomHeight: heights.slice(bestSplit).reduce((total, height) => total + height, 0),
  };
}

function getAddressGroupFontSize(group, pageCapacity, contentWidth) {
  // * 11092332 預設字體16 pt，資料欄相鄰間距 3 pt
  for (let fontSize = 16; fontSize >= 8; fontSize--) {
    if (estimateAddressGroupHeight(group, fontSize, contentWidth) <= pageCapacity) {
      return fontSize;
    }
  }
  return 8;
}

function estimateAddressGroupHeight(group, fontSize, contentWidth) {
  const columnMargins = getMemberColumnMargins();
  const fieldWidths = getMemberColumnWidths().map((width, index) => {
    return width / 20 - (columnMargins.left[index] + columnMargins.right[index]) / 20;
  });
  const rowsHeight = group.members.reduce((total, member, rowIndex) => {
    return total + estimateMemberRowHeight(group, member, rowIndex, fieldWidths, fontSize);
  }, 0);
  const firstMemberHeight = estimateMemberRowHeight(
    group, group.members[0], 0, fieldWidths, fontSize
  );
  return firstMemberHeight + ADDRESS_MEMBER_GAP_TWIPS / 20 + rowsHeight +
    ADDRESS_GROUP_TRAILING_GAP_TWIPS / 20;
}

function estimateMemberRowHeight(group, member, rowIndex, fieldWidths, fontSize) {
  const lineCount = Math.max(...member.map((value, index) => {
    return index === 4
      ? 1
      : estimateWrappedLines(value, fieldWidths[index], fontSize);
  }));
  const topMargin = rowIndex === 0 ? 0 : 2.5;
  const bottomMargin = 2.5;
  return lineCount * fontSize * 1.2 + topMargin + bottomMargin + 1;
}

const ADDRESS_MEMBER_GAP_TWIPS = 113;
const ADDRESS_GROUP_TRAILING_GAP_TWIPS = 350;

function estimateWrappedLines(value, width, fontSize) {
  const textWidth = Array.from(value || "").reduce((total, character) => {
    return total + (/[^\u0000-\u00ff]/.test(character) ? fontSize : fontSize * 0.55);
  }, 0);
  return Math.max(1, Math.ceil(textWidth / width));
}

function normalizeAddress(address) {
  return String(address || "").replace(/[\s\u3000]+/g, "").trim();
}

function getMemberColumnWidths() {
  const totalWidth = 14570;
  const proportions = [2.5, 2.5, 2.5, 4, 8.6, 2.5, 2.6, 2.6];
  const totalProportion = proportions.reduce((total, proportion) => total + proportion, 0);
  const exactWidths = proportions.map(proportion => totalWidth * proportion / totalProportion);
  const widths = exactWidths.map(Math.floor);
  let remainingWidth = totalWidth - widths.reduce((total, width) => total + width, 0);
  const fractionalOrder = exactWidths
    .map((width, index) => ({ index, fraction: width - widths[index] }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; index < remainingWidth; index++) {
    widths[fractionalOrder[index].index]++;
  }
  return widths;
}

function getMemberColumnMargins() {
  return {
    left: [0, 0, 0, 0, 0, 0, 0, 0],
    right: [57, 170, 60, 60, 60, 60, 60, 0],
  };
}

// * 11100852 修正住址排和資料排間距
function buildWordPageTable(
  page,
  columnWidths,
  halfCapacityTwips,
  centerGapTwips,
  startOnNewPage
) {
  const totalWidth = columnWidths.reduce((total, width) => total + width, 0);
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map(edge => `<w:${edge} w:val="nil"/>`).join("");
  const grid = columnWidths.map(width => `<w:gridCol w:w="${width}"/>`).join("");
  const rows = [
    ...page.topGroups.flatMap((group, index) => {
      return buildWordAddressGroupRows(
        group,
        columnWidths,
        startOnNewPage && index === 0,
        true
      );
    }),
    buildWordSpacerRow(
      columnWidths,
      Math.max(20, halfCapacityTwips - Math.round(page.topHeight * 20)),
      "",
      true
    ),
    ...buildWordCenterGapRows(columnWidths, centerGapTwips),
    ...page.bottomGroups.flatMap((group, index) => {
      return buildWordAddressGroupRows(
        group,
        columnWidths,
        false,
        index < page.bottomGroups.length - 1
      );
    }),
  ].join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
    `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}

function buildWordAddressGroupRows(
  group,
  columnWidths,
  startOnNewPage = false,
  keepFollowing = false
) {
  const totalWidth = columnWidths.reduce((total, width) => total + width, 0);
  const addressStartColumn = 2;
  const addressOffsetWidth = columnWidths
    .slice(0, addressStartColumn)
    .reduce((total, width) => total + width, 0);
  const addressWidth = totalWidth - addressOffsetWidth;
  const memberCellBorders = [
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/>',
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/>',
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/>',
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/>',
  ].join("");
  const addressOffsetCell =
    `<w:tc><w:tcPr><w:tcW w:w="${addressOffsetWidth}" w:type="dxa"/>` +
    `<w:gridSpan w:val="${addressStartColumn}"/>` +
    '</w:tcPr><w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:tc>';
  const addressCell =
    `<w:tc><w:tcPr><w:tcW w:w="${addressWidth}" w:type="dxa"/>` +
    `<w:gridSpan w:val="${columnWidths.length - addressStartColumn}"/><w:noWrap/><w:tcFitText/>` +
    '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>' +
    '<w:textDirection w:val="lrTb"/><w:vAlign w:val="center"/></w:tcPr>' +
    `<w:p><w:pPr>${startOnNewPage ? "<w:pageBreakBefore/>" : ""}` +
    '<w:keepNext/><w:spacing w:before="0" w:after="0"/><w:jc w:val="left"/></w:pPr>' +
    `<w:r><w:rPr><w:b/><w:sz w:val="${group.fontSize * 2}"/>` +
    `</w:rPr><w:t xml:space="preserve">${escapeXml(group.address)}</w:t></w:r></w:p></w:tc>`;
  const columnMargins = getMemberColumnMargins();
  const fieldWidths = columnWidths.map((width, index) => {
    return width / 20 - (columnMargins.left[index] + columnMargins.right[index]) / 20;
  });
  const addressHeightTwips = Math.ceil(estimateMemberRowHeight(
    group,
    group.members[0],
    0,
    fieldWidths,
    group.fontSize
  ) * 20);
  const rows = [
    `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${addressHeightTwips}" w:hRule="exact"/></w:trPr>${addressOffsetCell}${addressCell}</w:tr>`,
    buildWordSpacerRow(columnWidths, ADDRESS_MEMBER_GAP_TWIPS, "", true),
  ];
  const memberRows = group.members.map((member, rowIndex) => {
    const cells = member.map((value, index) => {
      const width = columnWidths[index];
      const leftMargin = columnMargins.left[index];
      const rightMargin = columnMargins.right[index];
      // * 11101500 欄A和欄B的格式要求備註：停用特殊方向、禁止換行、縮放與英數方向控制。
      const direction = index < 2 ? "" : '<w:textDirection w:val="btLr"/>';
      const keepTogether = index === 4;
      const noWrap = keepTogether ? "<w:noWrap/>" : "";
      const fitText = keepTogether ? "<w:tcFitText/>" : "";
      const topMargin = rowIndex === 0 ? 0 : 50;
      const bottomMargin = 50;
      const keepNext = rowIndex < group.members.length - 1 ||
        index < member.length - 1 ||
        (keepFollowing && rowIndex === group.members.length - 1 && index === member.length - 1);
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
        `${noWrap}${fitText}<w:tcBorders>${memberCellBorders}</w:tcBorders>` +
        `<w:tcMar><w:top w:w="${topMargin}" w:type="dxa"/>` +
        `<w:left w:w="${leftMargin}" w:type="dxa"/><w:bottom w:w="${bottomMargin}" w:type="dxa"/>` +
        `<w:right w:w="${rightMargin}" w:type="dxa"/></w:tcMar>` +
        `${direction}<w:vAlign w:val="center"/></w:tcPr>` +
        `<w:p><w:pPr>${keepNext ? "<w:keepNext/>" : ""}` +
        '<w:spacing w:before="0" w:after="0"/><w:jc w:val="left"/></w:pPr>' +
        `<w:r><w:rPr><w:sz w:val="${group.fontSize * 2}"/>` +
        `</w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p></w:tc>`;
    }).join("");
    const rowHeightTwips = Math.ceil(estimateMemberRowHeight(
      group,
      member,
      rowIndex,
      fieldWidths,
      group.fontSize
    ) * 20);
    return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${rowHeightTwips}" w:hRule="exact"/></w:trPr>${cells}</w:tr>`;
  }).join("");
  rows.push(memberRows);
  rows.push(buildWordSpacerRow(
    columnWidths,
    ADDRESS_GROUP_TRAILING_GAP_TWIPS,
    "",
    keepFollowing
  ));
  return rows;
}

function buildWordCenterGapRows(columnWidths, heightTwips) {
  const firstHalfHeight = Math.floor(heightTwips / 2);
  const secondHalfHeight = heightTwips - firstHalfHeight;
  return [
    buildWordSpacerRow(columnWidths, firstHalfHeight, "", true, true),
    buildWordSpacerRow(columnWidths, secondHalfHeight, "", true),
  ];
}

function buildWordSpacerRow(
  columnWidths,
  heightTwips,
  cellBorders = "",
  keepNext = false,
  dashedLine = false
) {
  const totalWidth = columnWidths.reduce((total, width) => total + width, 0);
  const cell =
    `<w:tc><w:tcPr><w:tcW w:w="${totalWidth}" w:type="dxa"/>` +
    `<w:gridSpan w:val="${columnWidths.length}"/>` +
    `${dashedLine ? '<w:tcBorders><w:bottom w:val="dashed" w:sz="6" w:space="0" w:color="000000"/></w:tcBorders>' : ""}` +
    `${cellBorders}` +
    '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>' +
    `</w:tcPr><w:p><w:pPr>${keepNext ? "<w:keepNext/>" : ""}` +
    `<w:spacing w:before="0" w:after="0" w:line="${dashedLine ? heightTwips : 20}" w:lineRule="exact"/>` +
    '</w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p></w:tc>';
  return `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${heightTwips}" w:hRule="exact"/></w:trPr>${cell}</w:tr>`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getCellText(value, timezone, datePattern) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, timezone, datePattern || "yyyy年MM月dd日");
  }
  return value == null ? "" : String(value).trim();
}

// * 11092304 Word 文字270 度旋轉，A3直向
function createA3PortraitWordFile(groups, docTitle, wordFolderId) {
  const files = [
    Utilities.newBlob(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
      "application/xml",
      "[Content_Types].xml"
    ),
    Utilities.newBlob(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
      "application/xml",
      "_rels/.rels"
    ),
    Utilities.newBlob(buildWordDocumentXml(groups), "application/xml", "word/document.xml"),
  ];
  const docxBlob = Utilities.zip(files, `${docTitle}_A3直式.docx`)
    .setContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  return DriveApp.getFolderById(wordFolderId).createFile(docxBlob);
}
