const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/documents'];
const GOOGLE_DOC_ID = process.env.GOOGLE_DOC_ID || '';
const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'google-service-account.json');

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_FILE,
    scopes: SCOPES,
  });
  return auth;
}

async function getDocContent(docId = GOOGLE_DOC_ID) {
  const auth = await getAuth();
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId: docId });
  return doc.data;
}

async function appendFormattedText(text, color = null, bold = false, docId = GOOGLE_DOC_ID) {
  const auth = await getAuth();
  const docs = google.docs({ version: 'v1', auth });
  
  // Get current end index
  const doc = await docs.documents.get({ documentId: docId });
  const content = doc.data.body.content;
  let endIndex = 1;
  for (const element of content) {
    if (element.endIndex) {
      endIndex = Math.max(endIndex, element.endIndex);
    }
  }
  
  const startIndex = endIndex - 1;
  const requests = [];
  
  // Insert text first
  requests.push({
    insertText: {
      location: { index: startIndex },
      text: text
    }
  });
  
  // Apply formatting if specified
  if (color || bold) {
    const textStyle = {};
    if (color) {
      textStyle.foregroundColor = {
        color: { rgbColor: color }
      };
    }
    if (bold) {
      textStyle.bold = true;
    }
    
    requests.push({
      updateTextStyle: {
        range: {
          startIndex: startIndex,
          endIndex: startIndex + text.length
        },
        textStyle: textStyle,
        fields: color && bold ? 'foregroundColor,bold' : (color ? 'foregroundColor' : 'bold')
      }
    });
  }
  
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests }
  });
  
  console.log('Formatted text appended');
}

// Red color for Fugu edits
const RED = { red: 0.8, green: 0.1, blue: 0.1 };

// CLI interface
async function main() {
  const cmd = process.argv[2];
  if (!GOOGLE_DOC_ID) {
    throw new Error('Missing GOOGLE_DOC_ID environment variable');
  }
  
  if (cmd === 'get') {
    const doc = await getDocContent();
    // Extract plain text
    let text = '';
    for (const element of doc.body.content) {
      if (element.paragraph) {
        for (const elem of element.paragraph.elements) {
          if (elem.textRun) {
            text += elem.textRun.content;
          }
        }
      }
    }
    console.log(text);
  } else if (cmd === 'append-red') {
    const text = process.argv[3];
    await appendFormattedText(text, RED);
  } else if (cmd === 'append-bold') {
    const text = process.argv[3];
    await appendFormattedText(text, null, true);
  } else {
    console.log('Usage: node gdocs-formatted.js <get|append-red|append-bold> [text]');
  }
}

main().catch(console.error);
