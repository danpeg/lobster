const { google } = require('googleapis');
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

async function getPlainText(docId) {
  const docs = await getDocsClient();
  const doc = await docs.documents.get({ documentId: docId });
  let text = '';

  for (const element of doc.data.body.content || []) {
    if (!element.paragraph) continue;
    for (const part of element.paragraph.elements || []) {
      if (part.textRun?.content) text += part.textRun.content;
    }
  }

  return text;
}

async function main() {
  const docId = process.argv[2] || GOOGLE_DOC_ID;
  if (!docId) {
    throw new Error('Missing Google Doc ID. Set GOOGLE_DOC_ID or pass <docId>.');
  }

  const text = await getPlainText(docId);
  console.log(text);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
