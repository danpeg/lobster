const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/documents'];
const DEFAULT_DOC_ID = process.env.GOOGLE_DOC_ID || '';
const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'google-service-account.json');

async function getAuth() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_FILE,
    scopes: SCOPES,
  });
  return auth;
}

async function clearDoc(docId = DEFAULT_DOC_ID) {
  const auth = await getAuth();
  const docs = google.docs({ version: 'v1', auth });
  
  // Get current doc content
  const doc = await docs.documents.get({ documentId: docId });
  const content = doc.data.body.content;
  
  // Find the end index (last content element)
  let endIndex = 1;
  for (const element of content) {
    if (element.endIndex) {
      endIndex = Math.max(endIndex, element.endIndex);
    }
  }
  
  // Delete all content except the first character (required by API)
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

async function appendText(docId = DEFAULT_DOC_ID, text) {
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
  
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: endIndex - 1 },
          text: text
        }
      }]
    }
  });
  
  console.log('Text appended');
}

async function writeDoc(docId = DEFAULT_DOC_ID, text) {
  await clearDoc(docId);
  await appendText(docId, text);
}

// CLI interface
const cmd = process.argv[2];
const docIdArg = process.argv[3];
const text = process.argv[4];

// Use provided doc ID or fall back to default
const activeDocId = docIdArg || DEFAULT_DOC_ID;
if (!activeDocId) {
  console.error('Missing Google Doc ID. Set GOOGLE_DOC_ID or pass <docId>.');
  process.exit(1);
}

if (cmd === 'clear') {
  clearDoc(activeDocId).catch(console.error);
} else if (cmd === 'append' && docIdArg) {
  appendText(activeDocId, text).catch(console.error);
} else if (cmd === 'write' && docIdArg) {
  writeDoc(activeDocId, text).catch(console.error);
} else {
  console.log('Usage: node gdocs.js <clear|append|write> <docId> [text]');
}
