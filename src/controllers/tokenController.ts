import { Request, Response } from "express";
import { pool } from "../config/database";
import { redisClient } from "../config/redis";

const refreshTokenLabel = (lbl: string) => {
  return `refresh_token:${lbl}`;
};

export const tokenController = {
  // List all active refresh tokens for current user
  findAll: async (req: Request, res: Response) => {
    const userId = (req as any).user.id || (req as any).user_id;

    const result = await pool.query(
      `SELECT id, token_jti, device_name, ip_address, created_at, expired_at,
    CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
         WHEN expires_at < NOW() THEN 'expired'
         ELSE 'active' END as status
     FROM refresh_tokens
     WHERE user_id = $1
     ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows;
  },
  // Revoke specific token
  revoke: async (req: Request, res: Response) => {
    const tokenId = req.params.tokenId;
    const userId = (req as any).user.id || (req as any).user_id;

    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT token_jti FROM refresh_tokens
            WHERE id = $1 AND user_id = $2`,
        [tokenId, userId],
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "Token not found",
        });
      }

      const { token_jti } = result.rows[0];

      await client.query("BEGIN");

      // Update DB
      await pool.query(
        `UPDATE refresh_tokens 
        SET revoked_at = NOW(), is_active = FALSE 
        WHERE id = $1`,
        [tokenId],
      );

      // Clear from Redis
      await redisClient.del(refreshTokenLabel(token_jti));

      await pool.query("COMMIT");

      res.json({
        success: true,
        message: "Token revoked successfully",
      });
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error(err);

      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  },
  // Revoke all active tokens
  revokeAll: async (req: Request, res: Response) => {
    const userId = (req as any).user.id || (req as any).user_id;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Get all active tokens
      const tokenResult = await client.query(
        `SELECT token_jti FROM refresh_tokens
            WHERE user_id = $1 AND is_active = TRUE`,
        [userId],
      );

      // Clear all from Redis
      for (const row of tokenResult.rows) {
        await redisClient.del(refreshTokenLabel(row.token_jti));
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: `Revoked ${tokenResult.rows.length} token(s)`,
        revokedCount: tokenResult.rows.length,
      });
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error("Error revoking all tokens:", err);
      res.status(500).json({ success: false, error: err.message });
    } finally {
      client.release();
    }
  },
};
