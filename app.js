require("dotenv").config();

const express=require("express");
const mongoose=require("mongoose");
const {google}=require("googleapis");
const {GoogleGenerativeAI}=require("@google/generative-ai");

const app=express();
app.use(express.json());

const PORT=process.env.PORT||3000;

// =========================
// CHECK ENV VARIABLES
// =========================

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

for(const name of requiredEnv){
    if(!process.env[name]){
        console.error(`❌ Missing environment variable: ${name}`);
        process.exit(1);
    }
}

// =========================
// MONGODB
// =========================

mongoose.connect(process.env.MONGODB_URI)
.then(()=>{
    console.log("🍃 MongoDB connected");
})
.catch((error)=>{
    console.error("❌ MongoDB connection failed:",error.message);
    process.exit(1);
});

// =========================
// EMAIL SCHEMA
// =========================

const processedEmailSchema=new mongoose.Schema({
    messageId:{
        type:String,
        required:true,
        unique:true
    },
    subject:String,
    from:String,
    processedAt:{
        type:Date,
        default:Date.now
    },
    requiresCall:Boolean
});

const ProcessedEmail=mongoose.model(
    "ProcessedEmail",
    processedEmailSchema
);

// =========================
// GEMINI
// =========================

const genAI=new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
);

const model=genAI.getGenerativeModel({
    model:"gemini-2.5-flash"
});

// =========================
// GOOGLE AUTH
// =========================

const oauth2Client=new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
    refresh_token:process.env.GOOGLE_REFRESH_TOKEN
});

const gmail=google.gmail({
    version:"v1",
    auth:oauth2Client
});

// =========================
// GET EMAIL BODY
// =========================

function decodeBase64(data){
    return Buffer.from(
        data.replace(/-/g,"+").replace(/_/g,"/"),
        "base64"
    ).toString("utf8");
}

function getBody(payload){

    if(!payload){
        return "";
    }

    if(payload.body&&payload.body.data){
        return decodeBase64(payload.body.data);
    }

    if(payload.parts){

        for(const part of payload.parts){

            if(
                part.mimeType==="text/plain" &&
                part.body &&
                part.body.data
            ){
                return decodeBase64(part.body.data);
            }

            const result=getBody(part);

            if(result){
                return result;
            }
        }
    }

    return "";
}

// =========================
// GET FULL EMAIL
// =========================

async function getEmail(messageId){

    const response=await gmail.users.messages.get({
        userId:"me",
        id:messageId,
        format:"full"
    });

    const payload=response.data.payload;

    const headers=payload.headers||[];

    const subjectHeader=headers.find(
        h=>h.name.toLowerCase()==="subject"
    );

    const fromHeader=headers.find(
        h=>h.name.toLowerCase()==="from"
    );

    return {
        id:messageId,
        subject:subjectHeader?.value||"",
        from:fromHeader?.value||"",
        body:getBody(payload)
    };
}

// =========================
// GEMINI ANALYSIS
// =========================

async function analyzeEmail(email){

    const prompt=`
You are an AI email assistant whose job is to decide whether the user should receive a phone call about an email.

Analyze the email carefully.

An email SHOULD require a phone call if:
- It is urgent
- It contains an interview, job opportunity, deadline, meeting, appointment, payment issue, security alert, or important personal matter
- The user needs to take action soon
- Missing the email could cause a significant problem

An email should NOT require a call if:
- It is a newsletter
- It is promotional/advertising
- It is a normal notification
- It is unimportant
- No action is required

Return ONLY valid JSON.

{
    "important":true,
    "priority":"high",
    "category":"job",
    "summary":"short summary",
    "requires_call":true
}

Email:

From: ${email.from}

Subject: ${email.subject}

Body:
${email.body}
`;

    const result=await model.generateContent(prompt);

    let response=result.response.text().trim();

    response=response.replace(/^```json\s*/,"");
    response=response.replace(/^```\s*/,"");
    response=response.replace(/\s*```$/,"");

    return JSON.parse(response);
}

// =========================
// EDESY CALL
// =========================

async function makeCall(summary){

    const response=await fetch(
        "https://voice-agent.edesy.in/api/v1/calls",
        {
            method:"POST",
            headers:{
                "Content-Type":"application/json",
                "Authorization":
                    `Bearer ${process.env.EDESY_API_KEY}`
            },
            body:JSON.stringify({
                agentId:Number(process.env.EDESY_AGENT_ID),
                phoneNumber:process.env.MY_PHONE_NUMBER,
                variables:{
                    email_summary:summary
                }
            })
        }
    );

    const data=await response.json();

    if(!response.ok){
        throw new Error(JSON.stringify(data));
    }

    return data;
}

// =========================
// PROCESS EMAIL
// =========================

async function processEmail(email){

    console.log("🤖 Sending email to Gemini...");

    const analysis=await analyzeEmail(email);

    console.log("🤖 Gemini Analysis:");
    console.log(analysis);

    if(analysis.requires_call===true){

        console.log("📞 Important email detected!");
        console.log("Calling your phone...");

        const callResult=await makeCall(
            analysis.summary
        );

        console.log("✅ Edesy call initiated");

        console.log(callResult);

        return analysis;
    }

    console.log("ℹ️ Email is not important. No call.");

    return analysis;
}

// =========================
// CHECK GMAIL
// =========================

let checking=false;

async function checkEmails(){

    if(checking){
        return;
    }

    checking=true;

    try{

        const response=await gmail.users.messages.list({
            userId:"me",
            maxResults:10
        });

        const messages=response.data.messages||[];

        for(const message of messages){

            const messageId=message.id;

            // =========================
            // CHECK MONGODB
            // =========================

            const alreadyProcessed=
                await ProcessedEmail.findOne({
                    messageId
                });

            if(alreadyProcessed){

                console.log(
                    `⏭️ Already processed: ${messageId}`
                );

                continue;
            }

            // =========================
            // GET EMAIL
            // =========================

            const email=await getEmail(messageId);

            console.log("\n📧 New Email");
            console.log(`From: ${email.from}`);
            console.log(`Subject: ${email.subject}`);

            // =========================
            // IMPORTANT:
            // SAVE BEFORE GEMINI
            // =========================

            const record=
                await ProcessedEmail.create({
                    messageId,
                    subject:email.subject,
                    from:email.from,
                    requiresCall:null
                });

            console.log(
                "💾 Email ID saved to MongoDB"
            );

            // =========================
            // GEMINI + EDESY
            // =========================

            try{

                const analysis=
                    await processEmail(email);

                await ProcessedEmail.updateOne(
                    {_id:record._id},
                    {
                        requiresCall:
                            analysis.requires_call
                    }
                );

                console.log("✅ Email processed.");

            }catch(error){

                console.error(
                    "❌ Email processing failed:",
                    error.message
                );

                console.log(
                    "⚠️ Email will NOT be processed again."
                );
            }
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

// =========================
// HEALTH ROUTE
// =========================

app.get("/",(req,res)=>{

    res.json({
        status:"running",
        service:"AI Email Caller"
    });

});

// =========================
// START SERVER
// =========================

app.listen(PORT,async()=>{

    console.log(
        `🌐 Server running on port ${PORT}`
    );

    console.log(
        "🚀 AI Email Caller started!"
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
});