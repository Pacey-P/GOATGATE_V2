import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dummyFilePath = path.join(__dirname, 'dummy_clip.mp4');

// Create a dummy video file
fs.writeFileSync(dummyFilePath, 'dummy video content');

async function testUpload() {
  const form = new FormData();
  form.append('clip', fs.createReadStream(dummyFilePath));
  form.append('title', 'Test DVR Clip');
  form.append('developer', 'TestRunner');
  form.append('type', 'dvr');
  form.append('gateCode', 'HNGG');
  form.append('tags', JSON.stringify(['Test', 'DVR']));

  console.log('Sending mock clip to http://localhost:3001/api/clips...');
  try {
    const res = await axios.post('http://localhost:3001/api/clips', form, {
      headers: form.getHeaders(),
    });
    console.log('Upload success response:', res.data);
  } catch (err) {
    console.error('Upload failed:', err.response ? err.response.data : err.message);
  } finally {
    // clean up dummy file
    if (fs.existsSync(dummyFilePath)) {
      fs.unlinkSync(dummyFilePath);
    }
    // delete self
    if (fs.existsSync(import.meta.url ? fileURLToPath(import.meta.url) : __filename)) {
      fs.unlinkSync(import.meta.url ? fileURLToPath(import.meta.url) : __filename);
    }
  }
}

testUpload();
