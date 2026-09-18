require("dotenv").config();

const express=require("express");
const cors=require("cors");
const mongoose=require("mongoose");
const {google}=require("googleapis");
const {GoogleGenerativeAI}=require("@google/generative-ai");

const Email=require("./models/Email");


const app=express();

const PORT=process.env.PORT||3000;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(express.json());


// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const requiredEnv=[
    "GEMINI_API_KEY",
    "EDESY_API_KEY",
    "EDESY_AGENT_ID",
    "MY_PHONE_NUMBER",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "MONGODB_URI"
];


for(const variable of requiredEnv){

    if(!process.env[variable]){

        console.error(
            `❌ Missing environment variable: ${variable}`
        );

        process.exit(1);
    }
}


// ============================================================
// GEMINI
// ============================================================

const genAI=new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
);

const model=genAI.getGenerativeModel({
    model:"gemini-2.5-flash"
});


let geminiCooldownUntil=0;


// ============================================================
// MONGODB
// ============================================================

async function connectMongoDB(){

    console.log(
        "🔌 Connecting to MongoDB..."
    );

    await mongoose.connect(
        process.env.MONGODB_URI
    );

    console.log(
        "🍃 MongoDB connected"
    );
}


// ============================================================
// GOOGLE OAUTH
// ============================================================

const oauth2Client=new google.auth.OAuth2(

    process.env.GOOGLE_CLIENT_ID,

    process.env.GOOGLE_CLIENT_SECRET
);


oauth2Client.setCredentials({

    refresh_token:
        process.env.GOOGLE_REFRESH_TOKEN

});


const gmail=google.gmail({

    version:"v1",

    auth:oauth2Client

});


// ============================================================
// HELPERS
// ============================================================

function decodeBase64(data){

    if(!data){
        return "";
    }

    return Buffer
        .from(
            data
                .replace(/-/g,"+")
                .replace(/_/g,"/"),
            "base64"
        )
        .toString("utf-8");
}


function extractBody(payload){

    if(!payload){
        return "";
    }


    if(
        payload.mimeType==="text/plain" &&
        payload.body &&
        payload.body.data
    ){

        return decodeBase64(
            payload.body.data
        );
    }


    if(payload.parts){

        for(const part of payload.parts){

            const body=
                extractBody(part);

            if(body){
                return body;
            }
        }
    }


    if(
        payload.body &&
        payload.body.data
    ){

        return decodeBase64(
            payload.body.data
        );
    }


    return "";
}


function getHeader(headers,name){

    if(!headers){
        return "";
    }


    const header=headers.find(

        h=>
            h.name.toLowerCase()===
            name.toLowerCase()

    );


    return header
        ? header.value
        : "";
}


// ============================================================
// GEMINI ANALYSIS
// ============================================================

async function analyzeEmail(email){

    if(Date.now()<geminiCooldownUntil){

        const remaining=Math.ceil(

            (
                geminiCooldownUntil-
                Date.now()
            )/1000

        );


        throw new Error(
            `Gemini quota cooldown active. Retry in ${remaining}s.`
        );
    }


    console.log(
        "🤖 Sending email to Gemini..."
    );


    const prompt=`

You are an AI email assistant whose job is to decide whether the user should receive a phone call about an email.

Analyze the email carefully.

An email SHOULD require a phone call if:

- It is urgent
- It contains an interview
- It contains a job opportunity
- It contains an important deadline
- It contains a meeting
- It contains an appointment
- It contains an important payment issue
- It contains a security alert
- It contains an important personal matter
- The user needs to take action soon
- Missing the email could cause a significant problem

An email should NOT require a call if:

- It is a newsletter
- It is promotional
- It is advertising
- It is a normal notification
- It is unimportant
- No action is required

Return ONLY valid JSON.

Use this exact structure:

{
    "important":true,
    "priority":"high",
    "category":"job",
    "summary":"short summary",
    "requires_call":true
}

Priority must be one of:

"high"
"medium"
"low"

Do not include markdown.

Email:

${email}

`;


    try{

        const result=
            await model.generateContent(
                prompt
            );


        let response=
            result.response
                .text()
                .trim();


        response=response.replace(
            /^```json\s*/,
            ""
        );


        response=response.replace(
            /^```\s*/,
            ""
        );


        response=response.replace(
            /\s*```$/,
            ""
        );


        return JSON.parse(
            response
        );


    }catch(error){

        if(
            error.message.includes("429") ||
            error.message.includes("quota") ||
            error.message.includes("Too Many Requests")
        ){

            console.error(
                "🚫 Gemini quota exceeded."
            );


            let cooldown=60000;


            const match=
                error.message.match(
                    /retryDelay[":\s]+["']?(\d+)s/
                );


            if(match){

                cooldown=
                    (Number(match[1])+5)*
                    1000;
            }


            geminiCooldownUntil=
                Date.now()+
                cooldown;


            console.log(
                `⏸️ Gemini paused for ${Math.ceil(cooldown/1000)} seconds.`
            );
        }


        throw error;
    }
}


// ============================================================
// EDESY CALL
// ============================================================

async function makeCall(summary){

    console.log(
        "📞 Calling your phone..."
    );


    const response=await fetch(

        "https://voice-agent.edesy.in/api/v1/calls",

        {

            method:"POST",

            headers:{

                "Content-Type":
                    "application/json",

                "Authorization":
                    `Bearer ${process.env.EDESY_API_KEY}`

            },

            body:JSON.stringify({

                agentId:
                    Number(
                        process.env.EDESY_AGENT_ID
                    ),

                phoneNumber:
                    process.env.MY_PHONE_NUMBER,

                variables:{

                    email_summary:
                        summary

                }

            })

        }

    );


    const data=
        await response.json();


    if(!response.ok){

        throw new Error(
            JSON.stringify(data)
        );
    }


    return data;
}


// ============================================================
// PROCESS EMAIL
// ============================================================

async function processEmail(message){

    const messageId=message.id;


    // --------------------------------------------------------
    // CHECK IF EMAIL ALREADY EXISTS
    // --------------------------------------------------------

    const existing=
        await Email.findOne({
            messageId
        });


    if(existing){

        return;
    }


    // --------------------------------------------------------
    // GET FULL GMAIL MESSAGE
    // --------------------------------------------------------

    const emailData=
        await gmail.users.messages.get({

            userId:"me",

            id:messageId,

            format:"full"

        });


    const payload=
        emailData.data.payload;


    const headers=
        payload.headers||[];


    const from=
        getHeader(
            headers,
            "From"
        );


    const to=
        getHeader(
            headers,
            "To"
        );


    const subject=
        getHeader(
            headers,
            "Subject"
        );


    const dateHeader=
        getHeader(
            headers,
            "Date"
        );


    const body=
        extractBody(
            payload
        );


    const receivedAt=
        dateHeader
            ? new Date(dateHeader)
            : new Date();


    const emailText=`

From: ${from}

To: ${to}

Subject: ${subject}

Email:

${body}

`;


    console.log(
        "\n📧 New Email"
    );


    console.log(
        `From: ${from}`
    );


    console.log(
        `Subject: ${subject}`
    );


    // --------------------------------------------------------
    // CREATE DATABASE RECORD
    // --------------------------------------------------------

    let emailRecord;


    try{

        emailRecord=
            await Email.create({

                messageId,

                threadId:
                    emailData.data.threadId||
                    null,

                from,

                to,

                subject,

                body,

                receivedAt,

                processingStatus:
                    "processing",

                attempts:1

            });


    }catch(error){

        if(error.code===11000){

            console.log(
                "⏭️ Email already exists."
            );

            return;
        }


        throw error;
    }


    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    try{

        const analysis=
            await analyzeEmail(
                emailText
            );


        console.log(
            "\n🤖 Gemini Analysis:"
        );


        console.log(
            JSON.stringify(
                analysis,
                null,
                2
            )
        );


        emailRecord.aiAnalysis={

            important:
                analysis.important===true,

            priority:
                analysis.priority||
                "low",

            category:
                analysis.category||
                "general",

            summary:
                analysis.summary||
                "",

            requiresCall:
                analysis.requires_call===true,

            analyzedAt:
                new Date()

        };


        // ----------------------------------------------------
        // EDESY
        // ----------------------------------------------------

        if(
            analysis.requires_call===true
        ){

            console.log(
                "\n📞 Important email detected!"
            );


            try{

                const callResult=
                    await makeCall(
                        analysis.summary
                    );


                const callData=
                    callResult?.data||
                    callResult;


                emailRecord.callAttempts.push({

                    attemptNumber:1,

                    edesyConversationId:
                        callData?.conversationId||
                        null,

                    edesyCallSid:
                        callData?.callSid||
                        null,

                    initiatedAt:
                        new Date(),

                    status:
                        "initiated"

                });


                console.log(
                    "✅ Edesy call initiated"
                );


                console.log(
                    JSON.stringify(
                        callResult,
                        null,
                        2
                    )
                );


            }catch(error){

                console.error(
                    "❌ Edesy call failed:",
                    error.message
                );


                emailRecord.callAttempts.push({

                    attemptNumber:1,

                    initiatedAt:
                        new Date(),

                    status:
                        "failed",

                    failureReason:
                        error.message

                });
            }


        }else{

            console.log(
                "ℹ️ Email is not important. No call."
            );
        }


        emailRecord.processingStatus=
            "completed";


        emailRecord.processedAt=
            new Date();


        await emailRecord.save();


        console.log(
            "✅ Email processed."
        );


    }catch(error){

        console.error(
            "❌ Email processing failed:",
            error.message
        );


        emailRecord.processingStatus=
            "failed";


        emailRecord.lastError=
            error.message;


        await emailRecord.save();
    }
}


// ============================================================
// GMAIL MONITOR
// ============================================================

let checking=false;


async function checkEmails(){

    if(checking){
        return;
    }


    if(Date.now()<geminiCooldownUntil){

        const remaining=Math.ceil(

            (
                geminiCooldownUntil-
                Date.now()
            )/1000

        );


        console.log(
            `⏸️ Gemini quota cooldown: ${remaining}s remaining`
        );


        return;
    }


    checking=true;


    try{

        const response=
            await gmail.users.messages.list({

                userId:"me",

                maxResults:10

            });


        const messages=
            response.data.messages||
            [];


        if(messages.length===0){

            console.log(
                "📭 No emails found."
            );

            return;
        }


        for(const message of messages){

            if(
                Date.now()<
                geminiCooldownUntil
            ){

                break;
            }


            await processEmail(
                message
            );
        }


    }catch(error){

        console.error(
            "❌ Gmail check failed:",
            error.message
        );


    }finally{

        checking=false;
    }
}


// ============================================================
// FRONTEND API
// ============================================================


// Health

app.get("/",(req,res)=>{

    res.json({

        status:"running",

        service:
            "REWA AI Email Caller",

        mongodb:
            mongoose.connection.readyState===1
                ? "connected"
                : "disconnected",

        gemini:
            Date.now()<geminiCooldownUntil
                ? "cooldown"
                : "available"

    });
});


// ============================================================
// ALL EMAILS
// ============================================================

app.get(
    "/api/emails",
    async(req,res)=>{

        try{

            const emails=
                await Email.find()
                    .sort({
                        receivedAt:-1
                    })
                    .lean();


            res.json(emails);


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch emails"

            });
        }
    }
);


// ============================================================
// IMPORTANT EMAILS
// ============================================================

app.get(
    "/api/emails/important",
    async(req,res)=>{

        try{

            const emails=
                await Email.find({

                    "aiAnalysis.important":
                        true

                })
                .sort({
                    receivedAt:-1
                })
                .lean();


            res.json(emails);


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch important emails"

            });
        }
    }
);


// ============================================================
// SINGLE EMAIL
// ============================================================

app.get(
    "/api/emails/:id",
    async(req,res)=>{

        try{

            const email=
                await Email.findById(
                    req.params.id
                ).lean();


            if(!email){

                return res.status(404).json({

                    error:
                        "Email not found"

                });
            }


            res.json(email);


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch email"

            });
        }
    }
);


// ============================================================
// CALLS
// ============================================================

app.get(
    "/api/calls",
    async(req,res)=>{

        try{

            const emails=
                await Email.find({

                    "aiAnalysis.requiresCall":
                        true

                })
                .sort({
                    receivedAt:-1
                })
                .lean();


            res.json(emails);


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch calls"

            });
        }
    }
);


// ============================================================
// STATS
// ============================================================

app.get(
    "/api/stats",
    async(req,res)=>{

        try{

            const totalEmails=
                await Email.countDocuments();


            const importantEmails=
                await Email.countDocuments({

                    "aiAnalysis.important":
                        true

                });


            const callsRequired=
                await Email.countDocuments({

                    "aiAnalysis.requiresCall":
                        true

                });


            const callsReceived=
                await Email.countDocuments({

                    "callAttempts":{
                        $elemMatch:{
                            status:
                                "received"
                        }
                    }

                });


            const callsNotReceived=
                await Email.countDocuments({

                    "aiAnalysis.requiresCall":
                        true,

                    "callAttempts":{
                        $not:{
                            $elemMatch:{
                                status:
                                    "received"
                            }
                        }
                    }

                });


            res.json({

                totalEmails,

                importantEmails,

                callsRequired,

                callsReceived,

                callsNotReceived

            });


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch statistics"

            });
        }
    }
);


// ============================================================
// TIMELINE
// ============================================================

app.get(
    "/api/timeline",
    async(req,res)=>{

        try{

            const emails=
                await Email.find()
                    .sort({
                        receivedAt:-1
                    })
                    .lean();


            const timeline=[];


            for(const email of emails){

                timeline.push({

                    id:
                        `${email._id}-email`,

                    emailId:
                        email._id,

                    type:
                        "email_received",

                    title:
                        "Email Received",

                    description:
                        email.subject,

                    timestamp:
                        email.receivedAt

                });


                if(
                    email.aiAnalysis &&
                    email.aiAnalysis.analyzedAt
                ){

                    timeline.push({

                        id:
                            `${email._id}-ai`,

                        emailId:
                            email._id,

                        type:
                            "ai_analysis",

                        title:
                            "AI Analysis",

                        description:
                            email.aiAnalysis.summary,

                        timestamp:
                            email.aiAnalysis.analyzedAt

                    });
                }


                for(
                    const call
                    of email.callAttempts||[]
                ){

                    timeline.push({

                        id:
                            `${email._id}-${call._id}`,

                        emailId:
                            email._id,

                        type:
                            "call",

                        title:
                            "Call",

                        description:
                            call.status,

                        timestamp:
                            call.initiatedAt,

                        status:
                            call.status,

                        duration:
                            call.duration||0

                    });
                }
            }


            timeline.sort(

                (a,b)=>
                    new Date(b.timestamp)-
                    new Date(a.timestamp)

            );


            res.json(
                timeline
            );


        }catch(error){

            console.error(error);


            res.status(500).json({

                error:
                    "Failed to fetch timeline"

            });
        }
    }
);


// ============================================================
// START SERVER
// ============================================================

async function startServer(){

    try{

        await connectMongoDB();


        app.listen(

            PORT,

            async()=>{

                console.log(
                    `🌐 Server running on port ${PORT}`
                );


                console.log(
                    "🚀 REWA AI Email Caller started!"
                );


                console.log(
                    "🔐 Using Google OAuth refresh token..."
                );


                console.log(
                    "👀 Monitoring Gmail..."
                );


                await checkEmails();


                setInterval(

                    checkEmails,

                    30000

                );

            }
        );


    }catch(error){

        console.error(

            "❌ MongoDB connection failed:",

            error.message

        );


        process.exit(1);
    }
}


startServer();