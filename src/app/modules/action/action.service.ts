
import { Request } from "express";
import { prisma } from "../../lib/prisma";

const get_all_action_from_db = async (req: Request) => {
  // define your own login here
  const result = await prisma.action.findMany();
  return result;
};

const get_single_action_from_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.action.findUnique({where:{id}});
  return result;
};

const create_action_into_db = async (req: Request) => {
  // define your own login here
  const result = await prisma.action.create({data:req.body});
  return result;
};

const update_action_into_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.action.update({where:{id},data:req.body});
  return result;
};

const delete_action_from_db = async (req: Request) => {
  // define your own login here
  const { id } = req.params;
  const result = await prisma.action.delete({where:{id}});
  return result;
};

export const action_service = {
  get_all_action_from_db,
  get_single_action_from_db,
  create_action_into_db,
  update_action_into_db,
  delete_action_from_db,
};
    