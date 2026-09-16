require("dotenv").config();

const express=require("express");
const {google}=require("googleapis");
const {GoogleGenerativeAI}=require("@google/generative-ai");
const fs=require("fs").promises;
const path=require("path");

const app=express();

app.use(express.json());

const PORT=process.env.PORT || 3000;


/* =========================
   GEMINI
========================= */

const genAI=new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
);

const model=genAI.getGenerativeModel({
    model:"gemini-2.5-flash"
});


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
${email}
`;

    const result=
        await model.generateContent(prompt);

    let response=
        result.response.text().trim();

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

    return JSON.parse(response);
}


/* =========================
   EDESY
========================= */

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

                agentId:
                    Number(
                        process.env.EDESY_AGENT_ID
                    ),

                phoneNumber:
                    process.env.MY_PHONE_NUMBER,

                variables:{
                    email_summary:summary
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


/* =========================
   GMAIL AUTHENTICATION
========================= */

const oauth2Client=
    new google.auth.OAuth2(
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


/* =========================
   PROCESSED EMAILS
========================= */

const PROCESSED_FILE=
    path.join(
        process.cwd(),
        "processedEmails.json"
    );


async function getProcessedEmails(){

    try{

        const content=
            await fs.readFile(
                PROCESSED_FILE,
                "utf-8"
            );

        return JSON.parse(content);

    }catch(error){

        return [];
    }
}


async function saveProcessedEmail(id){

    const emails=
        await getProcessedEmails();

    if(!emails.includes(id)){

        emails.push(id);

        await fs.writeFile(
            PROCESSED_FILE,
            JSON.stringify(
                emails,
                null,
                2
            )
        );
    }
}


/* =========================
   EMAIL BODY
========================= */

function decodeBody(data){

    return Buffer.from(
        data,
        "base64url"
    ).toString("utf-8");
}


function getEmailBody(payload){

    if(
        payload.body &&
        payload.body.data
    ){

        return decodeBody(
            payload.body.data
        );
    }


    if(payload.parts){

        for(const part of payload.parts){

            if(
                part.mimeType==="text/plain" &&
                part.body &&
                part.body.data
            ){

                return decodeBody(
                    part.body.data
                );
            }


            if(part.parts){

                const body=
                    getEmailBody(part);

                if(body){

                    return body;
                }
            }
        }
    }

    return "";
}


/* =========================
   PROCESS EMAIL
========================= */

async function processEmail(messageId){

    const email=
        await gmail.users.messages.get({

            userId:"me",

            id:messageId,

            format:"full"
        });


    const headers=
        email.data.payload.headers;


    const subject=
        headers.find(
            h=>
            h.name.toLowerCase()==="subject"
        );


    const from=
        headers.find(
            h=>
            h.name.toLowerCase()==="from"
        );


    const body=
        getEmailBody(
            email.data.payload
        );


    console.log("\n📧 New Email");

    console.log(
        "From:",
        from?.value
    );

    console.log(
        "Subject:",
        subject?.value
    );


    const emailText=`
Subject: ${subject?.value || ""}

${body}
`;


    console.log(
        "\n🤖 Sending email to Gemini..."
    );


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


    if(
        analysis.requires_call===true
    ){

        console.log(
            "\n📞 Important email detected!"
        );

        console.log(
            "Calling your phone..."
        );


        try{

            const callResult=
                await makeCall(
                    analysis.summary
                );


            console.log(
                "✅ Edesy call initiated"
            );

            console.log(
                callResult
            );

        }catch(error){

            console.error(
                "❌ Edesy call failed:",
                error.message
            );

            throw error;
        }

    }else{

        console.log(
            "\nℹ️ Email is not important. No call."
        );
    }
}


/* =========================
   CHECK GMAIL
========================= */

let checking=false;


async function checkEmails(){

    if(checking){

        console.log(
            "⏳ Previous Gmail check still running..."
        );

        return;
    }


    checking=true;


    try{

        const processedEmails=
            await getProcessedEmails();


        const result=
            await gmail.users.messages.list({

                userId:"me",

                maxResults:10

            });


        const messages=
            result.data.messages;


        if(
            !messages ||
            messages.length===0
        ){

            console.log(
                "📭 No emails found."
            );

            return;
        }


        for(const message of messages){

            if(
                processedEmails.includes(
                    message.id
                )
            ){

                continue;
            }


            try{

                await processEmail(
                    message.id
                );


                await saveProcessedEmail(
                    message.id
                );


                console.log(
                    "✅ Email processed."
                );


            }catch(error){

                console.error(
                    "❌ Email processing failed:",
                    error.message
                );

                console.log(
                    "⚠️ Email will be retried."
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


/* =========================
   START GMAIL MONITORING
========================= */

async function startMonitoring(){

    console.log(
        "\n🚀 AI Email Caller started!"
    );

    console.log(
        "🔐 Using Google OAuth refresh token..."
    );

    console.log(
        "👀 Monitoring Gmail..."
    );


    // Check immediately

    await checkEmails();


    // Check every 30 seconds

    setInterval(
        async()=>{

            console.log(
                "\n🔍 Checking for new emails..."
            );

            await checkEmails();

        },
        30*1000
    );
}


/* =========================
   HEALTH CHECK
========================= */

app.get(
    "/",
    (req,res)=>{

        res.json({
            status:"running",
            service:"AI Email Caller"
        });

    }
);


/* =========================
   START SERVER
========================= */

app.listen(
    PORT,
    ()=>{

        console.log(
            `🌐 Server running on port ${PORT}`
        );

        startMonitoring();

    }
);