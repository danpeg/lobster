const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/documents'];
const DOC_ID = process.env.GDOCS_DOC_ID || ''; 

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-service-account.json'),
    scopes: SCOPES,
  });
  return auth;
}

async function getEndIndex(docs, docId) {
  const doc = await docs.documents.get({ documentId: docId });
  const content = doc.data.body.content;
  let endIndex = 1;
  for (const element of content) {
    if (element.endIndex) {
      endIndex = Math.max(endIndex, element.endIndex);
    }
  }
  return endIndex;
}

// Insert text with native Google Docs formatting
// Supports: # H1, ## H2, ### H3, **bold**, *italic*, __underline__
async function appendFormatted(docId = DOC_ID, text) {
  const auth = await getAuth();
  const docs = google.docs({ version: 'v1', auth });
  
  const lines = text.split('\n');
  const requests = [];
  
  let currentIndex = await getEndIndex(docs, docId) - 1;
  
  for (const line of lines) {
    let cleanLine = line;
    let headingStyle = null;
    let boldRanges = [];
    let italicRanges = [];
    let underlineRanges = [];
    
    // Check for headings
    if (line.startsWith('### ')) {
      cleanLine = line.slice(4);
      headingStyle = 'HEADING_3';
    } else if (line.startsWith('## ')) {
      cleanLine = line.slice(3);
      headingStyle = 'HEADING_2';
    } else if (line.startsWith('# ')) {
      cleanLine = line.slice(2);
      headingStyle = 'HEADING_1';
    }
    
    // Parse inline formatting (**bold**, *italic*, __underline__)
    let processedLine = '';
    let i = 0;
    while (i < cleanLine.length) {
      // Bold **text**
      if (cleanLine.slice(i, i + 2) === '**') {
        const end = cleanLine.indexOf('**', i + 2);
        if (end !== -1) {
          const boldText = cleanLine.slice(i + 2, end);
          boldRanges.push({
            start: currentIndex + processedLine.length,
            end: currentIndex + processedLine.length + boldText.length
          });
          processedLine += boldText;
          i = end + 2;
          continue;
        }
      }
      // Underline __text__
      if (cleanLine.slice(i, i + 2) === '__') {
        const end = cleanLine.indexOf('__', i + 2);
        if (end !== -1) {
          const underText = cleanLine.slice(i + 2, end);
          underlineRanges.push({
            start: currentIndex + processedLine.length,
            end: currentIndex + processedLine.length + underText.length
          });
          processedLine += underText;
          i = end + 2;
          continue;
        }
      }
      // Italic *text*
      if (cleanLine[i] === '*' && cleanLine[i + 1] !== '*') {
        const end = cleanLine.indexOf('*', i + 1);
        if (end !== -1 && cleanLine[end - 1] !== '*') {
          const italicText = cleanLine.slice(i + 1, end);
          italicRanges.push({
            start: currentIndex + processedLine.length,
            end: currentIndex + processedLine.length + italicText.length
          });
          processedLine += italicText;
          i = end + 1;
          continue;
        }
      }
      processedLine += cleanLine[i];
      i++;
    }
    
    const lineWithNewline = processedLine + '\n';
    
    // Insert the text
    requests.push({
      insertText: {
        location: { index: currentIndex },
        text: lineWithNewline
      }
    });
    
    // Apply heading style
    if (headingStyle) {
      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: currentIndex,
            endIndex: currentIndex + lineWithNewline.length
          },
          paragraphStyle: { namedStyleType: headingStyle },
          fields: 'namedStyleType'
        }
      });
    }
    
    // Apply bold
    for (const range of boldRanges) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.start, endIndex: range.end },
          textStyle: { bold: true },
          fields: 'bold'
        }
      });
    }
    
    // Apply italic
    for (const range of italicRanges) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.start, endIndex: range.end },
          textStyle: { italic: true },
          fields: 'italic'
        }
      });
    }
    
    // Apply underline
    for (const range of underlineRanges) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: range.start, endIndex: range.end },
          textStyle: { underline: true },
          fields: 'underline'
        }
      });
    }
    
    currentIndex += lineWithNewline.length;
  }
  
  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests }
    });
  }
  
  console.log('Formatted text appended');
}

async function clearDoc(docId = DOC_ID) {
  const auth = await getAuth();
  const docs = google.docs({ version: 'v1', auth });
  
  const endIndex = await getEndIndex(docs, docId);
  
  if (endIndex > 2) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex - 1 }
          }
        }]
      }
    });
  }
  
  console.log('Document cleared');
}

// CLI interface
const cmd = process.argv[2];
const docIdArg = process.argv[3];
const text = process.argv.slice(4).join(' ');

const activeDocId = docIdArg || DOC_ID;
if (!activeDocId) {
  console.error("Missing Google Doc ID. Set GDOCS_DOC_ID or pass [docId].");
  process.exit(1);
}

if (cmd === 'clear') {
  clearDoc(activeDocId).catch(console.error);
} else if (cmd === 'append' && text) {
  appendFormatted(activeDocId, text).catch(console.error);
} else if (cmd === 'test') {
  // Test with formatted content
  const testText = `# Heading 1 Test
## Heading 2 Test
### Heading 3 Test
This has **bold text** and *italic text* and __underlined text__.
Normal paragraph here.`;
  appendFormatted(activeDocId, testText).catch(console.error);
} else {
  console.log('Usage: node gdocs-formatted.js <clear|append|test> [docId] [text]');
}
