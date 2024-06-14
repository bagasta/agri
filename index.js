require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
const express = require('express');
const fs = require('fs');
const path = require('path');
const Airtable = require('airtable');

// Inisialisasi Express
const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
const ASSISTANT_ID = process.env.ASSISTANT_ID;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Messages';
const AIRTABLE_MEMBER_TABLE_NAME = process.env.AIRTABLE_MEMBER_TABLE_NAME || 'Member';

console.log('Using Airtable Base ID:', AIRTABLE_BASE_ID);
console.log('Using Airtable API Key:', AIRTABLE_API_KEY ? 'API Key Set' : 'API Key Not Set');
console.log('Using Airtable Table Name:', AIRTABLE_TABLE_NAME);
console.log('Using Airtable Member Table Name:', AIRTABLE_MEMBER_TABLE_NAME);

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const threads = {};
const lastMessages = {}; // Tracking the last messages sent

// Path to LocalAuth session storage
const sessionPath = path.resolve(__dirname, '.wwebjs_auth', 'example'); // Sesuaikan jalur sesuai kebutuhan

// Check if the session directory exists
if (!fs.existsSync(sessionPath)) {
    console.log('Session directory does not exist, creating it...');
    fs.mkdirSync(sessionPath, { recursive: true });
} else {
    console.log('Session directory exists:', sessionPath);
}

// Log the files in the session directory
const sessionFiles = fs.readdirSync(sessionPath);
console.log('Files in session directory:', sessionFiles);

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "example" // Anda dapat menyesuaikan ID client untuk membedakan sesi
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Recommended for environments without multiple cores
            '--disable-gpu'
        ],
    },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
});

client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', async msg => {
    const phoneNumber = msg.from.split('@')[0];
    const messageContent = msg.body;
    console.log(`Received message from ${phoneNumber}: ${messageContent}`);

    // Check if the phone number is a registered member
    // const isMember = await checkIfMember(phoneNumber);
    // if (!isMember) {
    //     await msg.reply('Tidak terdaftar, Silahkan daftar sebagai member');
    //     return;
    // }

    // Save the message to Airtable
    try {
        await base(AIRTABLE_TABLE_NAME).create([
            {
                fields: {
                    PhoneNumber: phoneNumber,
                    Message: messageContent,
                    Timestamp: new Date().toISOString()
                }
            }
        ]);
        console.log('Message saved to Airtable');
    } catch (error) {
        console.error('Error saving message to Airtable:', error);
    }

    if (messageContent) {
        try {
            const threadId = threads[msg.from] || await openai.beta.threads.create().then(thread => thread.id);
            threads[msg.from] = threadId;
            console.log(`Thread ID for ${msg.from}: ${threadId}`);

            const response = await sendMessageToThread(threadId, msg.body);
            if (response) {
                console.log(`Sending response to ${msg.from}: ${response}`);
                msg.reply(response).catch(error => console.error('Failed to send message:', error));
            } else {
                console.log('No new response needed, identical to the last one');
            }
        } catch (error) {
            console.error('Error processing the AI response:', error);
            await msg.reply('Sorry, I encountered an error.');
        }
    }
});

async function checkIfMember(phoneNumber) {
    try {
        const response = await base(AIRTABLE_MEMBER_TABLE_NAME).select({
            filterByFormula: `{PhoneNumber} = '${phoneNumber}'`
        }).firstPage();
        return response.length > 0;
    } catch (error) {
        console.error('Error checking member status:', error);
        return false;
    }
}

async function sendMessageToThread(threadId, messageContent) {
    console.log(`Sending message to thread ${threadId}: ${messageContent}`);
    try {
        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: messageContent
        });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: ASSISTANT_ID
        });

        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        while (runStatus.status === "queued" || runStatus.status === "in_progress") {
            await new Promise(resolve => setTimeout(resolve, 1000));
            console.log(`Waiting for run to complete: Status is ${runStatus.status}`);
            runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        }

        console.log(`Run status completed, retrieving messages for thread ${threadId}`);
        const messages = await openai.beta.threads.messages.list(run.thread_id);
        console.log(`Messages received from thread ${threadId}: ${JSON.stringify(messages)}`);

        const latestMessage = messages.data
            .filter(message => message.role === 'assistant')
            .reduce((prev, current) => (prev.created_at > current.created_at) ? prev : current, { created_at: 0 });

        if (latestMessage) {
            const responseText = latestMessage.content.map(content => content.text.value).join('\n');
            console.log(`Latest assistant message: ${responseText}`);

            if (lastMessages[threadId] !== responseText) {
                lastMessages[threadId] = responseText;
                return responseText;
            } else {
                console.log('No new response needed, identical to the last one');
                return null; // Consider returning a placeholder or an indication that no new message is needed.
            }
        } else {
            console.error('No response from assistant');
            return 'No response from assistant';
        }
    } catch (error) {
        console.error('Error sending message to thread:', error);
        throw error;
    }
}

client.initialize().then(() => {
    console.log('Client initialized successfully');
}).catch(error => {
    console.error('Error initializing client:', error);
});

// Express server untuk menjaga bot tetap berjalan di Heroku
app.get('/', (req, res) => res.send('WhatsApp bot is running'));
app.listen(port, () => console.log(`Server is running on port ${port}`));

console.log('Server setup complete, awaiting messages...');
