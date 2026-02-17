const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const GOOGLE_DOC_ID = process.env.GOOGLE_DOC_ID || '';
const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'google-service-account.json');

async function getDocsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_FILE,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  return google.docs({ version: 'v1', auth });
}

async function appendText(docId, text) {
  const docs = await getDocsClient();
  const doc = await docs.documents.get({ documentId: docId });
  const content = doc.data.body.content || [];

  let endIndex = 1;
  for (const element of content) {
    if (element.endIndex) endIndex = Math.max(endIndex, element.endIndex);
  }

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: endIndex - 1 },
          text,
        },
      }],
    },
  });
}

async function main() {
  const inputPath = process.argv[2];
  const docId = process.argv[3] || GOOGLE_DOC_ID;
  if (!docId) {
    throw new Error('Missing Google Doc ID. Set GOOGLE_DOC_ID or pass <docId>.');
  }

  if (!inputPath) {
    throw new Error('Usage: node update-sow.js <input.txt> [docId]');
  }

  const text = fs.readFileSync(path.resolve(inputPath), 'utf8');
  await appendText(docId, text);
  console.log('Document updated successfully.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
