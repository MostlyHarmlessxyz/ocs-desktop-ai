import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// Imported before any store/crypto initialization, including development builds.
app.setName('OCS Desktop AI');
const userData = process.env.OCS_AI_USER_DATA || path.join(app.getPath('appData'), 'OCS Desktop AI');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setAppUserModelId('com.ocsdesktop.ai');
