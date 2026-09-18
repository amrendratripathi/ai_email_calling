const mongoose=require("mongoose");


const callAttemptSchema=new mongoose.Schema({

    attemptNumber:{
        type:Number,
        required:true
    },

    edesyConversationId:{
        type:String,
        default:null
    },

    edesyCallSid:{
        type:String,
        default:null
    },

    initiatedAt:{
        type:Date,
        default:Date.now
    },

    status:{
        type:String,

        enum:[
            "initiated",
            "ringing",
            "received",
            "not_received",
            "failed"
        ],

        default:"initiated"
    },

    receivedAt:{
        type:Date,
        default:null
    },

    endedAt:{
        type:Date,
        default:null
    },

    duration:{
        type:Number,
        default:0
    },

    failureReason:{
        type:String,
        default:null
    }

});


const emailSchema=new mongoose.Schema({

    messageId:{
        type:String,
        required:true,
        unique:true,
        index:true
    },

    threadId:{
        type:String,
        default:null
    },

    from:{
        type:String,
        default:""
    },

    to:{
        type:String,
        default:""
    },

    subject:{
        type:String,
        default:""
    },

    body:{
        type:String,
        default:""
    },

    receivedAt:{
        type:Date,
        required:true,
        index:true
    },


    aiAnalysis:{

        important:{
            type:Boolean,
            default:false
        },

        priority:{
            type:String,

            enum:[
                "low",
                "medium",
                "high"
            ],

            default:"low"
        },

        category:{
            type:String,
            default:"general"
        },

        summary:{
            type:String,
            default:""
        },

        requiresCall:{
            type:Boolean,
            default:false
        },

        analyzedAt:{
            type:Date,
            default:null
        }

    },


    callAttempts:{
        type:[callAttemptSchema],
        default:[]
    },


    processingStatus:{
        type:String,

        enum:[
            "pending",
            "processing",
            "completed",
            "failed"
        ],

        default:"pending",

        index:true
    },


    attempts:{
        type:Number,
        default:0
    },


    lastError:{
        type:String,
        default:null
    },


    processedAt:{
        type:Date,
        default:null
    }

},{
    timestamps:true
});


module.exports=
    mongoose.model(
        "Email",
        emailSchema
    );