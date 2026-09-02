import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import Stripe from "stripe";
import { OAuth2Client } from "google-auth-library";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // Initialize Stripe
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const app = express();

app.use(
    cors({
        origin: process.env.CLIENT_URL,
        credentials: true,
    })
);

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

const database = client.db("RecipeHub");
const featureCollection = database.collection("feature");
const usersCollection = database.collection("users");
const recipesCollection = database.collection("recipes");
const favoritesCollection = database.collection("favorites");
const reportsCollection = database.collection("reports");
const paymentsCollection = database.collection("payments"); // NEW: tracks confirmed Stripe payments

// ---------- STRIPE WEBHOOK ----------
// IMPORTANT: This route MUST be registered BEFORE express.json(),
// because Stripe signature verification requires the raw request body.
app.post(
    "/api/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
        const sig = req.headers["stripe-signature"];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error("Webhook signature verification failed:", err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        try {
            if (event.type === "checkout.session.completed") {
                const session = event.data.object;
                const { recipeId, userId } = session.metadata || {};

                if (recipeId && userId) {
                    await paymentsCollection.updateOne(
                        { userId, recipeId },
                        {
                            $set: {
                                userId,
                                recipeId,
                                sessionId: session.id,
                                paymentIntentId: session.payment_intent,
                                amount: session.amount_total,
                                currency: session.currency,
                                status: "paid",
                                purchasedAt: new Date(),
                            },
                        },
                        { upsert: true }
                    );
                } else {
                    console.error("Webhook missing metadata:", session.id);
                }
            }

            // Optional: handle failed/expired sessions so you can log/debug
            if (event.type === "checkout.session.expired") {
                console.log("Checkout session expired:", event.data.object.id);
            }

            res.status(200).json({ received: true });
        } catch (err) {
            console.error("Webhook handler error:", err);
            // Respond 500 so Stripe retries delivery
            res.status(500).json({ error: "Webhook handler failed" });
        }
    }
);

// All routes AFTER this line get parsed JSON bodies as normal
app.use(express.json());
app.use(cookieParser());

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
            .sort({ createdAt: -1 })
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
            price,
        } = req.body;

        if (
            !recipeName ||
            !recipeImage ||
            !category ||
            !cuisineType ||
            !difficultyLevel ||
            !preparationTime
        ) {
            return res.status(400).json({ error: "All required fields must be filled" });
        }

        if (!Array.isArray(ingredients) || ingredients.length === 0) {
            return res.status(400).json({ error: "At least one ingredient is required" });
        }

        if (!Array.isArray(instructions) || instructions.length === 0) {
            return res.status(400).json({ error: "At least one instruction step is required" });
        }

        const user = await usersCollection.findOne({ email: req.user.email });

        const newRecipe = {
            recipeName,
            recipeImage,
            category,
            cuisineType,
            difficultyLevel,
            preparationTime,
            ingredients,
            instructions,
            price: price ? parseFloat(price) : 9.99, // Default Price if not set
            authorId: req.user.id,
            authorName: user?.name || "Anonymous",
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

app.get("/api/recipes/mine", verifyToken, async (req, res) => {
    try {
        const recipes = await recipesCollection
            .find({ authorId: req.user.id })
            .sort({ createdAt: -1 })
            .toArray();

        res.status(200).json({ recipes });
    } catch (error) {
        console.error("Fetch my recipes error:", error);
        res.status(500).json({ error: "Failed to fetch your recipes" });
    }
});

// NEW: check whether the logged-in user has purchased a given recipe
app.get("/api/recipes/:id/purchase-status", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const purchase = await paymentsCollection.findOne({
            userId: req.user.id,
            recipeId: id,
            status: "paid",
        });

        res.status(200).json({ purchased: !!purchase });
    } catch (error) {
        console.error("Purchase status error:", error);
        res.status(500).json({ error: "Failed to check purchase status" });
    }
});

// ---------- PAYMENT SUCCESS PAGE: fetch confirmed transaction details ----------
app.get("/api/payments/session/:sessionId", verifyToken, async (req, res) => {
    try {
        const { sessionId } = req.params;

        const payment = await paymentsCollection.findOne({
            sessionId,
            userId: req.user.id, // ensure users can only view their own transactions
        });

        if (!payment) {
            return res.status(404).json({ error: "Transaction not found" });
        }

        // Also pull the recipe name for a nicer confirmation display
        let recipeName = null;
        if (ObjectId.isValid(payment.recipeId)) {
            const recipe = await recipesCollection.findOne(
                { _id: new ObjectId(payment.recipeId) },
                { projection: { recipeName: 1 } }
            );
            recipeName = recipe?.recipeName || null;
        }

        res.status(200).json({
            payment: {
                transactionId: payment.paymentIntentId || payment.sessionId,
                amount: payment.amount, // stored in cents (Stripe amount_total)
                currency: payment.currency,
                status: payment.status,
                purchasedAt: payment.purchasedAt,
                recipeId: payment.recipeId,
                recipeName,
            },
        });
    } catch (error) {
        console.error("Fetch payment session error:", error);
        res.status(500).json({ error: "Failed to fetch transaction details" });
    }
});

// ---------- MY PURCHASED RECIPES: list every recipe the user has paid for ----------
app.get("/api/payments/mine", verifyToken, async (req, res) => {
    try {
        const userPayments = await paymentsCollection
            .find({ userId: req.user.id, status: "paid" })
            .sort({ purchasedAt: -1 })
            .toArray();

        if (!userPayments.length) {
            return res.status(200).json({ recipes: [] });
        }

        const validRecipeIds = userPayments
            .filter((p) => ObjectId.isValid(p.recipeId))
            .map((p) => new ObjectId(p.recipeId));

        const recipes = await recipesCollection
            .find({ _id: { $in: validRecipeIds } })
            .toArray();

        // Attach each recipe's own purchase info (date, amount, transaction id)
        // so the frontend doesn't need a second lookup per recipe.
        const recipesWithPurchaseInfo = recipes.map((recipe) => {
            const payment = userPayments.find(
                (p) => p.recipeId === recipe._id.toString()
            );
            return {
                ...recipe,
                purchasedAt: payment?.purchasedAt || null,
                transactionId: payment?.paymentIntentId || payment?.sessionId || null,
                amountPaid: payment?.amount || null,
                currency: payment?.currency || null,
            };
        });

        // Keep most-recently-purchased first
        recipesWithPurchaseInfo.sort(
            (a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt)
        );

        res.status(200).json({ recipes: recipesWithPurchaseInfo });
    } catch (error) {
        console.error("Fetch purchased recipes error:", error);
        res.status(500).json({ error: "Failed to fetch purchased recipes" });
    }
});

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

app.delete("/api/recipes/:id", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });

        if (!recipe) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        if (recipe.authorId !== req.user.id) {
            return res
                .status(403)
                .json({ error: "Unauthorized operation. You can only delete your own recipes." });
        }

        const result = await recipesCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 1) {
            res.status(200).json({ message: "Recipe deleted successfully" });
        } else {
            res.status(400).json({ error: "Failed to delete recipe" });
        }
    } catch (error) {
        console.error("Delete recipe error:", error);
        res.status(500).json({ error: "Failed to delete recipe" });
    }
});

app.put("/api/recipes/:id", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            recipeName,
            recipeImage,
            category,
            cuisineType,
            difficultyLevel,
            preparationTime,
            ingredients,
            instructions,
            price,
        } = req.body;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });

        if (!recipe) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        if (recipe.authorId !== req.user.id) {
            return res
                .status(403)
                .json({ error: "Unauthorized operation. You can only update your own recipes." });
        }

        const updatedRecipe = {
            $set: {
                recipeName,
                recipeImage,
                category,
                cuisineType,
                difficultyLevel,
                preparationTime,
                ingredients,
                instructions,
                price: price ? parseFloat(price) : recipe.price || 9.99,
                updatedAt: new Date(),
            },
        };

        await recipesCollection.updateOne({ _id: new ObjectId(id) }, updatedRecipe);

        res.status(200).json({ message: "Recipe updated successfully" });
    } catch (error) {
        console.error("Update recipe error:", error);
        res.status(500).json({ error: "Failed to update recipe" });
    }
});

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

app.post("/api/recipes/:id/favorite", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const existingFav = await favoritesCollection.findOne({
            userId: req.user.id,
            recipeId: id,
        });

        if (existingFav) {
            await favoritesCollection.deleteOne({ _id: existingFav._id });
            return res.status(200).json({
                favorited: false,
                message: "Removed from favorites",
            });
        } else {
            const newFavorite = {
                userEmail: req.user.email,
                userId: req.user.id,
                recipeId: id,
                addedAt: new Date(),
            };

            await favoritesCollection.insertOne(newFavorite);
            return res.status(201).json({
                favorited: true,
                message: "Added to favorites",
            });
        }
    } catch (error) {
        console.error("Favorite toggle error:", error);
        res.status(500).json({ error: "Failed to update favorite status" });
    }
});

app.get("/api/favorites/mine", verifyToken, async (req, res) => {
    try {
        const userFavs = await favoritesCollection.find({ userId: req.user.id }).toArray();

        if (!userFavs.length) {
            return res.status(200).json({ recipes: [] });
        }

        const recipeIds = userFavs.map((fav) => new ObjectId(fav.recipeId));
        const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();

        res.status(200).json({ recipes });
    } catch (error) {
        console.error("Fetch favorites error:", error);
        res.status(500).json({ error: "Failed to fetch favorites" });
    }
});

app.delete("/api/favorites/:recipeId", verifyToken, async (req, res) => {
    try {
        const { recipeId } = req.params;
        const result = await favoritesCollection.deleteOne({
            userId: req.user.id,
            recipeId: recipeId,
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Favorite item not found" });
        }

        res.status(200).json({ message: "Removed from favorites successfully" });
    } catch (error) {
        console.error("Remove favorite error:", error);
        res.status(500).json({ error: "Failed to remove favorite" });
    }
});

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

// ---------- STRIPE CHECKOUT ROUTE ----------
app.post("/api/recipes/:id/checkout", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });
        if (!recipe) return res.status(404).json({ error: "Recipe not found" });

        // Already purchased? Don't let them pay twice.
        const existingPurchase = await paymentsCollection.findOne({
            userId: req.user.id,
            recipeId: id,
            status: "paid",
        });
        if (existingPurchase) {
            return res.status(400).json({ error: "You already own this recipe" });
        }

        const price = recipe.price || 9.99; // Fallback to 9.99 USD if price field doesn't exist
        const name = recipe.recipeName || recipe.title || "Recipe Access";

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: name,
                            images: recipe.recipeImage ? [recipe.recipeImage] : [],
                        },
                        unit_amount: Math.round(price * 100), // Stripe takes amounts in cents
                    },
                    quantity: 1,
                },
            ],
            success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&recipeId=${id}`,
            cancel_url: `${process.env.CLIENT_URL}/recipes/${id}?purchase=cancelled`,
            metadata: { recipeId: id, userId: req.user.id },
        });

        res.status(200).json({ url: session.url });
    } catch (error) {
        console.error("Stripe checkout error:", error);
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});

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

        const user = await usersCollection.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        if (user.isBlocked) {
            return res.status(403).json({ error: "Your account has been blocked" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000,
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

app.post("/api/auth/google", async (req, res) => {
    try {
        const { credential } = req.body; // Google ID token sent from the frontend

        if (!credential) {
            return res.status(400).json({ error: "Missing Google credential" });
        }

        // Verify the token is genuinely issued by Google for our Client ID
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const { email, name, picture } = payload;

        if (!email) {
            return res.status(400).json({ error: "Google account has no email" });
        }

        let user = await usersCollection.findOne({ email: email.toLowerCase() });

        if (user) {
            // Existing user — just log them in
            if (user.isBlocked) {
                return res.status(403).json({ error: "Your account has been blocked" });
            }
        } else {
            // New user — create an account (no password, since it's Google-authenticated)
            const newUser = {
                name: name || "Google User",
                email: email.toLowerCase(),
                image: picture || "",
                password: null, // no password for Google-only accounts
                role: "user",
                isBlocked: false,
                isPremium: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            const result = await usersCollection.insertOne(newUser);
            user = { ...newUser, _id: result.insertedId };
        }

        const token = jwt.sign(
            { id: user._id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.cookie("token", token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 7 * 24 * 60 * 60 * 1000,
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
        console.error("Google auth error:", error);
        return res.status(401).json({ error: "Google authentication failed" });
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
        req.user = decoded;
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

// ---------- ADMIN: USER MANAGEMENT ----------

app.patch("/api/admin/users/:id/block", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid user id" });
        }

        const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isBlocked: true, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ message: "User blocked successfully" });
    } catch (error) {
        console.error("Block user error:", error);
        res.status(500).json({ error: "Failed to block user" });
    }
});

app.patch("/api/admin/users/:id/unblock", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid user id" });
        }

        const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isBlocked: false, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ message: "User unblocked successfully" });
    } catch (error) {
        console.error("Unblock user error:", error);
        res.status(500).json({ error: "Failed to unblock user" });
    }
});

// ---------- ADMIN: RECIPE MANAGEMENT ----------

app.get("/api/admin/recipes", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const recipes = await recipesCollection
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.status(200).json({ recipes });
    } catch (error) {
        console.error("Fetch all recipes (admin) error:", error);
        res.status(500).json({ error: "Failed to fetch recipes" });
    }
});

app.delete("/api/admin/recipes/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const result = await recipesCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        res.status(200).json({ message: "Recipe deleted successfully" });
    } catch (error) {
        console.error("Admin delete recipe error:", error);
        res.status(500).json({ error: "Failed to delete recipe" });
    }
});

app.patch("/api/admin/recipes/:id/feature", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { isFeatured } = req.body; // true or false, sent from client

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid recipe id" });
        }

        const recipe = await recipesCollection.findOne({ _id: new ObjectId(id) });
        if (!recipe) {
            return res.status(404).json({ error: "Recipe not found" });
        }

        await recipesCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isFeatured: !!isFeatured, updatedAt: new Date() } }
        );

        // Keep featureCollection in sync since Home page reads from it
        if (isFeatured) {
            await featureCollection.updateOne(
                { recipeId: id },
                {
                    $set: {
                        recipeId: id,
                        recipeName: recipe.recipeName,
                        category: recipe.category,
                        cuisineType: recipe.cuisineType,
                        preparationTime: recipe.preparationTime,
                        recipeImage: recipe.recipeImage,
                    },
                },
                { upsert: true }
            );
        } else {
            await featureCollection.deleteOne({ recipeId: id });
        }

        res.status(200).json({ message: "Recipe feature status updated" });
    } catch (error) {
        console.error("Feature recipe error:", error);
        res.status(500).json({ error: "Failed to update feature status" });
    }
});

// ---------- ADMIN: REPORTS ----------

app.get("/api/admin/reports", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const reports = await reportsCollection
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

        res.status(200).json({ reports });
    } catch (error) {
        console.error("Fetch reports error:", error);
        res.status(500).json({ error: "Failed to fetch reports" });
    }
});

app.patch("/api/admin/reports/:id/dismiss", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid report id" });
        }

        const result = await reportsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "dismissed" } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Report not found" });
        }

        res.status(200).json({ message: "Report dismissed" });
    } catch (error) {
        console.error("Dismiss report error:", error);
        res.status(500).json({ error: "Failed to dismiss report" });
    }
});

app.delete("/api/admin/reports/:id/remove-recipe", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params; // this is the report's _id

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid report id" });
        }

        const report = await reportsCollection.findOne({ _id: new ObjectId(id) });
        if (!report) {
            return res.status(404).json({ error: "Report not found" });
        }

        // Delete the reported recipe
        if (ObjectId.isValid(report.recipeId)) {
            await recipesCollection.deleteOne({ _id: new ObjectId(report.recipeId) });
            await featureCollection.deleteOne({ recipeId: report.recipeId });
        }

        // Mark report as resolved
        await reportsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "resolved" } }
        );

        res.status(200).json({ message: "Recipe removed and report resolved" });
    } catch (error) {
        console.error("Remove reported recipe error:", error);
        res.status(500).json({ error: "Failed to remove recipe" });
    }
});

// ---------- ADMIN: DASHBOARD OVERVIEW ----------

app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
    try {
        const totalUsers = await usersCollection.countDocuments();
        const totalRecipes = await recipesCollection.countDocuments();
        const totalPremiumMembers = await usersCollection.countDocuments({ isPremium: true });
        const totalReports = await reportsCollection.countDocuments({ status: "pending" });

        res.status(200).json({
            totalUsers,
            totalRecipes,
            totalPremiumMembers,
            totalReports,
        });
    } catch (error) {
        console.error("Admin stats error:", error);
        res.status(500).json({ error: "Failed to fetch admin stats" });
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