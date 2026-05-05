
import { Request } from "express";
import { prisma } from "../../lib/prisma";

const get_all_risk_from_db = async (req: Request) => {
  // define your own login here
  const result = await prisma.risk.findMany();
  return result;
};

const get_single_risk_from_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.risk.findUnique({where:{id}});
  return result;
};

const create_risk_into_db = async (req: Request) => {
  // define your own login here
  const result = await prisma.risk.create({data:req.body});
  return result;
};

const update_risk_into_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.risk.update({where:{id},data:req.body});
  return result;
};

const delete_risk_from_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.risk.delete({where:{id}});
  return result;
};

export const risk_service = {
  get_all_risk_from_db,
  get_single_risk_from_db,
  create_risk_into_db,
  update_risk_into_db,
  delete_risk_from_db,
};
    