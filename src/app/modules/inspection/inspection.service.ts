
import { Request } from "express";
import { prisma } from "../../lib/prisma.js";

const get_all_inspection_from_db = async (req: Request) => {
  // define your own logic here
  const result = await prisma.inspection.findMany();
  return result;
};

const get_single_inspection_from_db = async (req: Request) => {
  // define your own logic here
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.findUnique({where:{id}});
  return result;
};

const create_inspection_into_db = async (req: Request) => {
  // define your own logic here
  const result = await prisma.inspection.create({data:req.body});
  return result;
};

const update_inspection_into_db = async (req: Request) => {
  // define your own logic here
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.update({where:{id},data:req.body});
  return result;
};

const delete_inspection_from_db = async (req: Request) => {
  // define your own logic here
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.delete({where:{id}});
  return result;
};

export const inspection_service = {
  get_all_inspection_from_db,
  get_single_inspection_from_db,
  create_inspection_into_db,
  update_inspection_into_db,
  delete_inspection_from_db,
};
    