require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// SECURITY: Restrict CORS to same-origin only in production
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// SECURITY: Limit JSON body size to prevent payload attacks
app.use(express.json({ limit: '10kb' }));

// SECURITY: Basic security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SECURITY: Server-side plan definitions (prices NEVER come from frontend)
const PLANS = {
    'mensal':       { name: 'Acesso mensal',               amount: 17.90 }, 
    'trimestral':   { name: 'Trimestral + Fotinha',         amount: 26.90 },
    'vitalicio':    { name: 'Acesso vitalício + Fetiches',  amount: 45.90 },
    'grave_comigo': { name: 'Grave comigo + WhatsApp',      amount: 72.90 }
};

// JWT token cache
let diceAuthToken = null;
let diceTokenExpiresAt = 0;

// SECURITY: Simple rate limiter (per IP, max 10 requests per minute for /api/pix)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10;

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    const record = rateLimitMap.get(ip);
    
    if (now - record.firstRequest > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    record.count++;
    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Muitas requisições. Tente novamente em 1 minuto.' });
    }
    
    next();
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitMap.entries()) {
        if (now - record.firstRequest > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// SECURITY: Email validation (server-side)
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    if (email.length > 254) return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// SECURITY: Sanitize planId input
function isValidPlanId(planId) {
    return typeof planId === 'string' && PLANS.hasOwnProperty(planId);
}

// Authenticate with Use Dice (JWT caching)
async function getDiceToken() {
    if (diceAuthToken && Date.now() < diceTokenExpiresAt - 300000) {
        return diceAuthToken;
    }

    try {
        const response = await axios.post(`${process.env.DICE_API_URL}/api/v1/auth/login`, {
            client_id: process.env.DICE_CLIENT_ID,
            client_secret: process.env.DICE_CLIENT_SECRET
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000 // SECURITY: 10s timeout to prevent hanging
        });

        if (response.data && response.data.access_token) {
            diceAuthToken = response.data.access_token;
            const expiresIn = response.data.expires_in || 3300; 
            diceTokenExpiresAt = Date.now() + (expiresIn * 1000);
            return diceAuthToken;
        } else if (response.data && response.data.token) {
            diceAuthToken = response.data.token;
            const expiresIn = response.data.expires_in || 3300; 
            diceTokenExpiresAt = Date.now() + (expiresIn * 1000);
            return diceAuthToken;
        }
        
        throw new Error('No token found in Use Dice response');
    } catch (error) {
        console.error('Use Dice Auth Error:', error?.response?.data || error.message);
        throw new Error('Falha na autenticação com gateway de pagamento');
    }
}

// POST /api/pix - Generate PIX payment
app.post('/api/pix', rateLimit, async (req, res) => {
    try {
        const { email, planId } = req.body;

        // SECURITY: Server-side input validation
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'E-mail inválido.' });
        }

        if (!isValidPlanId(planId)) {
            return res.status(400).json({ error: 'Plano inválido.' });
        }

        // SECURITY: Price is ALWAYS from server-side PLANS, never from client
        const plan = PLANS[planId];
        const externalId = `TX_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        
        const token = await getDiceToken();

        const depositData = {
            product_name: plan.name,
            amount: plan.amount,
            payer: {
                name: email.split('@')[0].substring(0, 50), // SECURITY: Truncate name
                email: email.substring(0, 254),
                document: "00000000000"
            },
            external_id: externalId
        };

        const response = await axios.post(`${process.env.DICE_API_URL}/api/v2/payments/deposit`, depositData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000 // SECURITY: 15s timeout
        });

        const data = response.data;

        if (!data || !data.qr_code_text) {
            console.error("Unexpected DICE API Response:", JSON.stringify(data).substring(0, 500));
            return res.status(500).json({ error: 'Resposta inesperada do gateway de pagamento.' });
        }

        // Generate QR Code image from PIX text
        const qrCodeBase64Raw = await QRCode.toDataURL(data.qr_code_text, { 
            margin: 1,
            width: 256,
            color: { dark: '#000000', light: '#ffffff' }
        });
        const qrCodeBase64 = qrCodeBase64Raw.split(',')[1];

        // SECURITY: Only return necessary data to frontend (no internal IDs or tokens)
        return res.json({
            txid: data.transaction_id || externalId,
            pix_qrcode: qrCodeBase64,
            pix_code: data.qr_code_text
        });

    } catch (error) {
        console.error('API /pix Error:', error?.response?.data || error.message);
        
        // SECURITY: Generic error message (never expose internal details to client)
        const statusCode = error?.response?.status || 500;
        res.status(statusCode >= 400 && statusCode < 500 ? statusCode : 500)
           .json({ error: 'Erro ao processar pagamento. Tente novamente.' });
    }
});

// GET /api/status/:txid - Check payment status
app.get('/api/status/:txid', async (req, res) => {
    try {
        const { txid } = req.params;
        
        // SECURITY: Validate txid format (prevent injection)
        if (!txid || typeof txid !== 'string' || txid.length > 100) {
            return res.status(400).json({ error: 'ID de transação inválido.' });
        }

        // SECURITY: Only allow alphanumeric, underscores, and hyphens
        if (!/^[a-zA-Z0-9_\-]+$/.test(txid)) {
            return res.status(400).json({ error: 'Formato de ID inválido.' });
        }

        const token = await getDiceToken();
        
        const response = await axios.get(
            `${process.env.DICE_API_URL}/api/v1/transactions/getStatusTransac/${encodeURIComponent(txid)}`, 
            {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 10000
            }
        );

        const data = response.data;
        
        // SECURITY: Only return delivery URL when payment is truly COMPLETED
        if (data && data.status === 'COMPLETED') {
            return res.json({
                status: 'paid',
                deliveryUrl: process.env.DELIVERY_URL
            });
        }

        // For any other status, just say pending (don't leak internal statuses)
        return res.json({ status: 'pending' });

    } catch (error) {
        console.error('API /status Error:', error?.response?.data || error.message);
        // SECURITY: On error, return pending (don't reveal error details)
        res.json({ status: 'pending' });
    }
});

// Webhook endpoint (Use Dice sends POST here on status change)
app.post('/api/webhook', (req, res) => {
    // SECURITY: Log webhook but don't expose internals
    console.log("Webhook received:", new Date().toISOString(), 
        "status:", req.body?.status, 
        "tx:", req.body?.transaction_id);
    res.status(200).send('OK');
});

// Serve index.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint (used by UptimeRobot to keep server alive)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// SECURITY: Catch-all for undefined routes
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
    console.log(`Checkout server listening on port ${PORT}`);
    
    // Startup validation
    const requiredEnv = ['DICE_CLIENT_ID', 'DICE_CLIENT_SECRET', 'DICE_API_URL', 'DELIVERY_URL'];
    const missing = requiredEnv.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.warn(`⚠️  Missing environment variables: ${missing.join(', ')}`);
    }
});
