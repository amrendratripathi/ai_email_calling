require("dotenv").config();

const express=require("express");
const {GoogleGenerativeAI}=require("@google/generative-ai");

const app=express();

app.use(express.json());

const genAI=new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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

    const result=await model.generateContent(prompt);

    let response=result.response.text().trim();

    // Remove markdown code fences if Gemini adds them
    response=response.replace(/^```json\s*/,"");
    response=response.replace(/^```\s*/,"");
    response=response.replace(/\s*```$/,"");

    return JSON.parse(response);
}


async function makeCall(){

    const response=await fetch(
        "https://voice-agent.edesy.in/api/v1/calls",
        {
            method:"POST",

            headers:{
                "Content-Type":"application/json",
                "Authorization":`Bearer ${process.env.EDESY_API_KEY}`
            },

            body:JSON.stringify({
                agentId:Number(process.env.EDESY_AGENT_ID),
                phoneNumber:process.env.MY_PHONE_NUMBER
            })
        }
    );

    const data=await response.json();

    if(!response.ok){
        throw new Error(JSON.stringify(data));
    }

    return data;
}


app.post("/analyze-email",async(req,res)=>{

    try{

        const {email}=req.body;

        if(!email){
            return res.status(400).json({
                error:"Email is required"
            });
        }

        console.log("\n📧 New Email:");
        console.log(email);

        // Step 1: Gemini analyzes email
        const analysis=await analyzeEmail(email);

        console.log("\n🤖 Gemini Analysis:");
        console.log(analysis);


        // Step 2: Check whether phone call is required
        if(analysis.requires_call===true){

            console.log("\n📞 Important email detected!");
            console.log("Calling your phone...");

            try{

                const callResult=await makeCall(analysis.summary);

                console.log("✅ Call initiated");

                return res.json({
                    analysis:analysis,
                    call:{
                        triggered:true,
                        result:callResult
                    }
                });

            }catch(error){

                console.error("❌ Edesy call failed:",error.message);

                return res.status(500).json({
                    analysis:analysis,
                    call:{
                        triggered:false,
                        error:error.message
                    }
                });
            }
        }


        // No call required
        console.log("\nℹ️ Email is not important. No call.");

        return res.json({
            analysis:analysis,
            call:{
                triggered:false
            }
        });


    }catch(error){

        console.error("❌ Error:",error.message);

        return res.status(500).json({
            error:"Something went wrong",
            details:error.message
        });
    }

});


app.listen(3000,()=>{
    console.log("🚀 Server running on http://localhost:3000");
});