import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();

// CORS - credentials: true লাগবে cookie পাঠানো/পাওয়ার জন্য
// origin wildcard ("*") ব্যবহার করা যাবে না যখন credentials true থাকে,
// তাই frontend এর exact URL বসাতে হবে
app.use(
    cors({
        origin: process.env.CLIENT_URL, // e.g. http://localhost:3000
        credentials: true,
    })
);
app.use(express.json());
app.use(cookieParser());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);


const database = client.db("RecipeHub");
const featureCollection = database.collection("feature");
const usersCollection = database.collection("users");
const recipesCollection = database.collection("recipes");
const reportsCollection = database.collection("reports");// Browse Recipe page এর জন্য

app.get("/", (req, res) => {
    res.send("Server is running");
});


app.get("/api/recipes/featured", async (req, res) => {
    try {
        const recipes = await featureCollection.find({}).toArray();
        res.status(200).json({ recipes });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch featured recipes" });
    }
});


app.get("/api/recipes", async (req, res) => {
    try {
        const recipes = await recipesCollection
            .find({ status: "published" })
            .sort({ createdAt: -1 }) // সর্বশেষ recipe আগে
            .toArray();

        res.status(200).json({ recipes });
    } catch (error) {
        console.error("Fetch recipes error:", error);
        res.status(500).json({ error: "Failed to fetch recipes" });
    }
});

app.post("/api/recipes", verifyToken, async (req, res) => {
    try {
        const {
            recipeName,
            recipeImage,
            category,
            cuisineType,
            difficultyLevel,
            preparationTime,
            ingredients,
            instructions,
        } = req.body;

        if (!recipeName || !recipeImage || !category || !cuisineType || !difficultyLevel || !preparationTime) {
            return res.status(400).json({ error: "All required fields must be filled" });
        }

        if (!Array.isArray(ingredients) || ingredients.length === 0) {
            return res.status(400).json({ error: "At least one ingredient is required" });
        }

        if (!Array.isArray(instructions) || instructions.length === 0) {
            return res.status(400).json({ error: "At least one instruction step is required" });
        }

        const newRecipe = {
            recipeName,
            recipeImage,
            category,
            cuisineType,
            difficultyLevel,
            preparationTime,
            ingredients,
            instructions,
            authorId: req.user.id,
            authorName: req.user.name || "",
            authorEmail: req.user.email,
            likeCount: 0,
            likedBy: [],
            isFeatured: false,
            status: "published",
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await recipesCollection.insertOne(newRecipe);

        res.status(201).json({
            message: "Recipe added successfully",
            recipeId: result.insertedId,
        });
    } catch (error) {
        console.error("Add recipe error:", error);
        res.status(500).json({ error: "Failed to add recipe" });
    }
});

app.get("/api/recipes/popular", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 8;

        const recipes = await recipesCollection
            .find({ status: "published" })
            .sort({ likeCount: -1 })
            .limit(limit)
            .toArray();

        res.status(200).json({ recipes });
    } catch (error) {
        console.error("Fetch popular recipes error:", error);
        res.status(500).json({ error: "Failed to fetch popular recipes" });
    }
});

// একটা নির্দিষ্ট recipe এর বিস্তারিত - View Details বাটনের জন্য
app.get("/api/recipes/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });

        if (!recipe) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        res.status(200).json({ recipe });
    } catch (error) {
        console.error("Fetch recipe error:", error);
        res.status(500).json({ error: "Failed to fetch recipe" });
    }
});



// ---------- LIKE ----------
// একজন ইউজার একবারই লাইক দিতে পারবে - likedBy array তে user id রাখা হচ্ছে
app.post("/api/recipes/:id/like", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });
        if (!recipe) return res.status(404).json({ error: "Recipe not found" });

        const likedBy = recipe.likedBy || [];
        const alreadyLiked = likedBy.some((uid) => uid === req.user.id);

        const update = alreadyLiked
            ? { $pull: { likedBy: req.user.id }, $inc: { likeCount: -1 } }
            : { $addToSet: { likedBy: req.user.id }, $inc: { likeCount: 1 } };

        await recipesCollection.updateOne({ _id: new ObjectId(id) }, update);
        const updated = await recipesCollection.findOne({ _id: new ObjectId(id) });

        res.status(200).json({ likeCount: updated.likeCount || 0, liked: !alreadyLiked });
    } catch (error) {
        res.status(500).json({ error: "Failed to update like" });
    }
});

// ---------- FAVORITE ----------
app.post("/api/recipes/:id/favorite", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

        const user = await usersCollection.findOne({ _id: new ObjectId(req.user.id) });
        const favorites = user.favorites || [];
        const alreadyFav = favorites.some((rid) => rid === id);

        const update = alreadyFav
            ? { $pull: { favorites: id } }
            : { $addToSet: { favorites: id } };

        await usersCollection.updateOne({ _id: new ObjectId(req.user.id) }, update);

        res.status(200).json({ favorited: !alreadyFav });
    } catch (error) {
        res.status(500).json({ error: "Failed to update favorite" });
    }
});

// ---------- REPORT ----------
app.post("/api/recipes/:id/report", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) return res.status(400).json({ error: "Reason is required" });
        if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

        await reportsCollection.insertOne({
            recipeId: id,
            reportedBy: req.user.id,
            reason,
            status: "pending",
            createdAt: new Date(),
        });

        res.status(201).json({ message: "Report submitted successfully" });
    } catch (error) {
        res.status(500).json({ error: "Failed to submit report" });
    }
});

// ---------- STRIPE CHECKOUT ----------
app.post("/api/recipes/:id/checkout", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });
        if (!recipe) return res.status(404).json({ error: "Recipe not found" });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: { name: recipe.title },
                        unit_amount: Math.round(recipe.price * 100), // cents এ
                    },
                    quantity: 1,
                },
            ],
            success_url: `${process.env.CLIENT_URL}/recipes/${id}?purchase=success`,
            cancel_url: `${process.env.CLIENT_URL}/recipes/${id}?purchase=cancelled`,
            metadata: { recipeId: id, userId: req.user.id },
        });

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error("Stripe checkout error:", error);
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});

// Registration route (আগে থেকেই আছে)
app.post("/api/register", async (req, res) => {
    try {
        const { name, email, image, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Name, email and password are required" });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        if (!/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
            return res.status(400).json({
                error: "Password must contain both uppercase and lowercase letters",
            });
        }

        const existingUser = await usersCollection.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(409).json({ error: "An account with this email already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            name,
            email: email.toLowerCase(),
            image: image || "",
            password: hashedPassword,
            role: "user",
            isBlocked: false,
            isPremium: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);

        const userToReturn = {
            id: result.insertedId,
            name: newUser.name,
            email: newUser.email,
            image: newUser.image,
            role: newUser.role,
        };

        return res.status(201).json({ message: "Registration successful", user: userToReturn });
    } catch (error) {
        console.error("Registration error:", error);
        return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        // ১. ইউজার খোঁজা
        const user = await usersCollection.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // ২. Blocked ইউজার চেক
        if (user.isBlocked) {
            return res.status(403).json({ error: "Your account has been blocked" });
        }

        // ৩. পাসওয়ার্ড মেলানো
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // ৪. JWT টোকেন তৈরি - role সহ, যাতে পরে অ্যাডমিন চেক করা যায়
        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // ৫. httpOnly cookie তে টোকেন সেট করা - JS দিয়ে (document.cookie) এটা পড়া যাবে না,
        // তাই XSS attack থেকে সুরক্ষিত থাকে
        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production", // production এ HTTPS বাধ্যতামূলক
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 দিন (ms এ)
        });

        const userToReturn = {
            id: user._id,
            name: user.name,
            email: user.email,
            image: user.image,
            role: user.role,
        };

        return res.status(200).json({ message: "Login successful", user: userToReturn });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});


app.get("/api/me", verifyToken, async (req, res) => {
    try {
        const user = await usersCollection.findOne(
            { email: req.user.email },
            { projection: { password: 0 } }
        );

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        return res.status(200).json({ user });
    } catch (error) {
        return res.status(500).json({ error: "Something went wrong" });
    }
});


app.post("/api/logout", (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
    });
    return res.status(200).json({ message: "Logged out successfully" });
});

function verifyToken(req, res, next) {
    const token = req.cookies.token;

    if (!token) {
        return res.status(401).json({ error: "Not authenticated" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { id, email, role } - পরের route এ req.user দিয়ে অ্যাক্সেস করা যাবে
        next();
    } catch (error) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}


function verifyAdmin(req, res, next) {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access only" });
    }
    next();
}


app.get("/api/dashboard", verifyToken, async (req, res) => {
    try {
        const user = await usersCollection.findOne({ email: req.user.email });
        return res.status(200).json({
            message: "Welcome to your dashboard",
            user: {
                name: user.name,
                email: user.email,
                image: user.image,
                role: user.role,
            },
        });
    } catch (error) {
        return res.status(500).json({ error: "Something went wrong" });
    }
});


app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const users = await usersCollection.find({}, { projection: { password: 0 } }).toArray();
        return res.status(200).json({ users });
    } catch (error) {
        return res.status(500).json({ error: "Something went wrong" });
    }
});

const PORT = process.env.PORT || 5000;

async function run() {
    try {
        await client.connect();
        console.log("MongoDB connected to RecipeHub");

        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    } catch (error) {
        console.error(`MongoDB connection failed: ${error.message}`);
        process.exit(1);
    }
}

run();