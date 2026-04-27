import { Router, Request, Response } from "express";
import { verifyMtnCallbackSignature } from "../middleware/mtnCallbackSignature";

const router = Router();

// This route is intended to receive MTN MoMo Open API callback payloads.
// Signature verification is applied to all incoming MTN callback requests.
router.use(verifyMtnCallbackSignature);

router.post("/callback", async (req: Request, res: Response) => {
  // Future callback processing can be added here.
  // Currently the MTN callback is authenticated and acknowledged.
  res.status(200).json({ status: "accepted" });
});

export default router;
