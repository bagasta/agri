require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
const ASSISTANT_ID = process.env.ASSISTANT_ID;

const threads = {};
const lastMessages = {}; // Tracking the last messages sent
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: 'session'
    }),
    puppeteer: { headless: true },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2410.1.html',
    }
});

client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', async msg => {
    console.log(`Received message from ${msg.from}: ${msg.body}`);
    if (msg.body) {
        try {
            const threadId = threads[msg.from] || await openai.beta.threads.create().then(thread => thread.id);
            threads[msg.from] = threadId;
            console.log(`Thread ID for ${msg.from}: ${threadId}`);

            const response = await sendMessageToThread(threadId, msg.body);
            if (response) {
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

async function sendMessageToThread(threadId, messageContent) {
    console.log(`Sending message to thread ${threadId}: ${messageContent}`);
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
        .reduce((prev, current) => (prev.created_at > current.created_at) ? prev : current, {created_at: 0});

    console.log(`Latest assistant message: ${latestMessage.content[0].text.value}`);
    const responseText = latestMessage.content.map(content => content.text.value).join('\n');

    if (lastMessages[threadId] !== responseText) {
        lastMessages[threadId] = responseText;
        return responseText;
    } else {
        console.log('No new response needed, identical to the last one');
        return null; // Consider returning a placeholder or an indication that no new message is needed.
    }
}


client.initialize();
